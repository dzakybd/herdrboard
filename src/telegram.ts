import { existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Card } from "./db.ts";
import { readJson, writeJson } from "./fs.ts";
import type { BoardEvent } from "./pipeline.ts";

/** Calls one Bot API method; throws with Telegram's description when it refuses. */
export type BotApi = (method: string, params: object, signal?: AbortSignal) => Promise<any>;

export function botApi(token: string): BotApi {
  return async (method, params, signal) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      // A hung call would hold up every event queued behind it.
      signal: signal ?? AbortSignal.timeout(CALL_MS),
    });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  };
}

/** Everything Telegram keeps, in `~/.herdrboard/telegram.json` (mode 600: it holds the token). */
interface State {
  token: string;
  bot: string;
  code: string; // sent as `/link <code>` to link a group
  chat_id?: number;
  user_id?: number; // the only sender listened to
  offset: number; // next getUpdates offset
  topics: Record<string, number>; // card id → forum topic (message_thread_id)
}

export type TelegramStatus = { enabled: false } | { enabled: true; bot: string; linked: true } | { enabled: true; bot: string; linked: false; code: string };

interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: { id: number; is_forum?: boolean };
  from?: { id: number };
  text?: string;
  photo?: unknown;
  document?: unknown;
  migrate_to_chat_id?: number;
}

interface Update {
  update_id: number;
  message?: Message;
}

const MAX_TEXT = 4000;
const POLL_SECONDS = 30;
const RETRY_MS = 5000;
const CALL_MS = 20_000;
/** What Telegram puts in `from` for a message an anonymous admin posts as the group. */
const ANONYMOUS_ADMIN = 1087968824;

/**
 * One bot, one forum group, one topic per card. Board events go out to the
 * card's topic; your text in that topic goes to the card's agent like a reply
 * on the board. Only the user who linked the group is listened to.
 */
export class Telegram {
  private bot: { state: State; api: BotApi } | null = null;
  private queue = Promise.resolve();
  private poller: AbortController | null = null;

  constructor(
    private home: string,
    private reply: (cardId: number, text: string) => Promise<void>,
    private apiFor: (token: string) => BotApi = botApi,
  ) {
    if (existsSync(this.path())) {
      const state = readJson<State>(this.path());
      this.bot = { state, api: apiFor(state.token) };
    }
  }

  status(): TelegramStatus {
    if (!this.bot) return { enabled: false };
    const { bot, chat_id, code } = this.bot.state;
    return chat_id ? { enabled: true, bot, linked: true } : { enabled: true, bot, linked: false, code };
  }

  /** Checks the token with getMe, then replaces any previous bot and starts listening. */
  async setup(token: string): Promise<TelegramStatus> {
    const api = this.apiFor(token);
    const me = await api("getMe", {});
    this.stop();
    this.bot = { state: { token, bot: me.username, code: randomBytes(8).toString("hex"), offset: 0, topics: {} }, api };
    this.save();
    this.start();
    return this.status();
  }

  disable(): TelegramStatus {
    this.stop();
    this.bot = null;
    rmSync(this.path(), { force: true });
    return this.status();
  }

  /** Queued so one card's events land in order and its topic is created once. Never throws. */
  notify(event: BoardEvent): void {
    this.queue = this.queue.then(() => this.send(event)).catch((e) => console.error(`telegram: ${(e as Error).message}`));
  }

  /** Resolves once every queued event was sent (tests use this). */
  flush(): Promise<void> {
    return this.queue;
  }

  start(): void {
    if (!this.bot || this.poller) return;
    const { api } = this.bot;
    const ctl = (this.poller = new AbortController());
    void (async () => {
      while (!ctl.signal.aborted) {
        try {
          const updates: Update[] = await api("getUpdates", { offset: this.bot!.state.offset, timeout: POLL_SECONDS, allowed_updates: ["message"] }, AbortSignal.any([ctl.signal, AbortSignal.timeout(POLL_SECONDS * 1000 + CALL_MS)]));
          if (ctl.signal.aborted) return;
          for (const u of updates) {
            // Saved before handling: a crash mid-reply drops that message rather than sending it to the agent twice.
            this.bot!.state.offset = u.update_id + 1;
            this.save();
            if (u.message) await this.handle(u.message).catch((e) => console.error(`telegram: ${(e as Error).message}`));
          }
        } catch (e) {
          if (ctl.signal.aborted) return;
          console.error(`telegram poll: ${(e as Error).message}`);
          await Bun.sleep(RETRY_MS);
        }
      }
    })();
  }

  stop(): void {
    this.poller?.abort();
    this.poller = null;
  }

  async handle(m: Message): Promise<void> {
    if (!this.bot) return;
    const { state, api } = this.bot;
    if (m.migrate_to_chat_id && m.chat.id === state.chat_id) {
      state.chat_id = m.migrate_to_chat_id;
      return this.save();
    }
    const link = m.text?.match(/^\/link(?:@\w+)?\s+([0-9a-f]+)\s*$/);
    if (link) return this.link(m, link[1]!);
    if (m.chat.id !== state.chat_id || m.from?.id !== state.user_id || !m.is_topic_message || !m.message_thread_id) return;
    const cardId = Object.keys(state.topics).find((id) => state.topics[id] === m.message_thread_id);
    if (!cardId) return;
    const answer = (text: string) => api("sendMessage", { chat_id: state.chat_id, message_thread_id: m.message_thread_id, text });
    if (!m.text) {
      if (m.photo || m.document) await answer("Files aren't passed on from Telegram yet: attach them on the board.");
      return;
    }
    try {
      await this.reply(Number(cardId), m.text);
    } catch (e) {
      await answer(`Not sent: ${(e as Error).message}`);
      return;
    }
    await api("setMessageReaction", { chat_id: state.chat_id, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] }).catch(() => {});
  }

  private async link(m: Message, code: string): Promise<void> {
    const { state, api } = this.bot!;
    if (state.chat_id || code !== state.code || !m.from) return;
    if (m.from.id === ANONYMOUS_ADMIN) {
      await api("sendMessage", { chat_id: m.chat.id, text: "You're posting as the group (anonymous admin). Turn that off for yourself, then send /link again." });
      return;
    }
    if (!m.chat.is_forum) {
      await api("sendMessage", { chat_id: m.chat.id, text: "Turn on Topics for this group first (group info → Edit → Topics), then send /link again." });
      return;
    }
    state.chat_id = m.chat.id;
    state.user_id = m.from.id;
    this.save();
    await api("sendMessage", { chat_id: m.chat.id, message_thread_id: m.message_thread_id, text: "Linked to herdrboard. Each card that needs you gets its own topic here." });
  }

  private async send({ kind, card }: BoardEvent): Promise<void> {
    if (!this.bot?.state.chat_id) return;
    const { state, api } = this.bot;
    let thread = state.topics[card.id];
    if (kind === "done") {
      if (thread) await api("closeForumTopic", { chat_id: state.chat_id, message_thread_id: thread });
      return;
    }
    const text = message(kind, card).slice(0, MAX_TEXT);
    if (thread) {
      try {
        return await api("sendMessage", { chat_id: state.chat_id, message_thread_id: thread, text });
      } catch (e) {
        // Topic deleted in Telegram: start a new one instead of failing every event for this card.
        if (!/thread not found/i.test((e as Error).message)) throw e;
      }
    }
    const topic = await api("createForumTopic", { chat_id: state.chat_id, name: `#${card.id} ${card.title}`.slice(0, 128) });
    thread = state.topics[card.id] = topic.message_thread_id as number;
    this.save();
    await api("sendMessage", { chat_id: state.chat_id, message_thread_id: thread, text });
  }

  private save(): void {
    if (this.bot) writeJson(this.path(), this.bot.state, 0o600);
  }

  private path(): string {
    return `${this.home}/telegram.json`;
  }
}

function message(kind: Exclude<BoardEvent["kind"], "done">, card: Card): string {
  if (kind === "ready") return `✅ Ready\n\n${card.summary || "(no summary)"}\n\nReply here to follow up, or finish it on the board.`;
  // No resume lane: the agent is gone, so a reply has nowhere to go.
  const next = card.resume_lane ? "Reply here to answer." : "Handle it on the board.";
  return `❓ Needs you\n\n${card.attention}\n\n${next}`;
}
