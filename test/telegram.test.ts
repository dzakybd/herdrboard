import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Card, Project } from "../src/db.ts";
import { Telegram } from "../src/telegram.ts";
import type { Board } from "../src/telegram-commands.ts";

const CHAT = -1001;
const ME = 42;
const card = { id: 5, title: "Fix login", brief: "", lane: "working", summary: null, attention: null, resume_lane: null } as Card;

let home: string;
let calls: { method: string; params: any }[];
let replies: { id: number; text: string }[];
let replyError: string | null;
let updates: any[][]; // each getUpdates call takes the next batch; then it hangs until aborted
let tg: Telegram;
let projects: Project[];
let cards: (Card & { agent_status: any })[];

const api = async (method: string, params: any, signal?: AbortSignal) => {
  if (method === "getUpdates") {
    const batch = updates.shift();
    if (batch) return batch;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }
  calls.push({ method, params });
  if (method === "getMe") return { username: "hb_bot" };
  if (method === "createForumTopic") return { message_thread_id: 101 };
  return true;
};
const fakeBoard: Board = {
  async reply(id, text) {
    if (replyError) throw new Error(replyError);
    replies.push({ id, text });
  },
  projects: () => projects,
  cards: () => cards,
  events: (id) => [{ id: 1, card_id: id, at: 0, text: "starting worker" }],
  addCard(project, title, brief) {
    const c = { ...card, id: 6, project_id: projects.find((p) => p.name === project)!.id, title, brief, lane: "todo" as const, agent_status: null };
    cards.push(c);
    return c;
  },
  async finish(id) {
    const c = cards.find((x) => x.id === id)!;
    c.lane = "done";
    return c;
  },
  async runAutomation(name) {
    if (name !== "nightly") throw new Error(`no automation '${name}'`);
    return card;
  },
};
const board = () => new Telegram(home, fakeBoard, () => api);

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/hb-tg-`);
  calls = [];
  replies = [];
  replyError = null;
  updates = [];
  projects = [{ id: 1, name: "web", path: "/repo/web" } as Project];
  cards = [{ ...card, agent_status: "working" }];
  tg = board();
});

afterEach(() => tg.stop());

async function linked() {
  const s = await tg.setup("123:abc");
  await tg.handle({ message_id: 1, chat: { id: CHAT, is_forum: true }, from: { id: ME }, text: `/link ${s.enabled && !s.linked ? s.code : ""}` });
  calls = [];
}

const inTopic = (thread: number, text: string, from = ME) => ({ message_id: 9, message_thread_id: thread, is_topic_message: true, chat: { id: CHAT }, from: { id: from }, text });
const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.text as string);

test("setup checks the token and keeps it in a private file", async () => {
  const s = await tg.setup("123:abc");
  expect(s).toEqual({ enabled: true, bot: "hb_bot", linked: false, code: expect.stringMatching(/^[0-9a-f]{16}$/) });
  expect(calls[0]!.method).toBe("getMe");
  expect(statSync(`${home}/telegram.json`).mode & 0o777).toBe(0o600);
});

test("only /link with the right code links, and the link survives a restart", async () => {
  const s = await tg.setup("123:abc");
  const code = s.enabled && !s.linked ? s.code : "";
  await tg.handle({ message_id: 1, chat: { id: CHAT, is_forum: true }, from: { id: 7 }, text: "/link 0000000000000000" });
  expect(tg.status()).toMatchObject({ linked: false });
  await tg.handle({ message_id: 2, chat: { id: CHAT, is_forum: true }, from: { id: ME }, text: `/link@hb_bot ${code}` });
  expect(tg.status()).toEqual({ enabled: true, bot: "hb_bot", linked: true });
  expect(board().status()).toEqual({ enabled: true, bot: "hb_bot", linked: true });
});

test("a group without Topics is not linked", async () => {
  const s = await tg.setup("123:abc");
  await tg.handle({ message_id: 1, chat: { id: CHAT, is_forum: false }, from: { id: ME }, text: `/link ${s.enabled && !s.linked ? s.code : ""}` });
  expect(tg.status()).toMatchObject({ linked: false });
  expect(sent().at(-1)).toContain("Turn on Topics");
});

test("a card gets one topic; what it needs and its summary post there, and Finish closes it", async () => {
  await linked();
  tg.notify({ kind: "needs_you", card: { ...card, lane: "needs_you", attention: "Which DB?", resume_lane: "working" } });
  tg.notify({ kind: "ready", card: { ...card, lane: "ready", summary: "fixed it" } });
  tg.notify({ kind: "done", card: { ...card, lane: "done" } });
  await tg.flush();
  expect(calls.map((c) => c.method)).toEqual(["createForumTopic", "sendMessage", "sendMessage", "closeForumTopic"]);
  expect(calls[0]!.params).toEqual({ chat_id: CHAT, name: "#5 Fix login" });
  expect(calls[1]!.params).toMatchObject({ chat_id: CHAT, message_thread_id: 101 });
  expect(sent()[0]).toBe("❓ <b>Needs you</b>\n\nWhich DB?\n\n<i>Reply here to answer.</i>");
  expect(calls[1]!.params.parse_mode).toBe("HTML");
  expect(sent()[1]).toContain("fixed it");
  expect(calls[3]!.params).toEqual({ chat_id: CHAT, message_thread_id: 101 });
});

test("a failed send is logged and later events still go out", async () => {
  await linked();
  const real = api;
  let fail = true;
  (tg as any).bot.api = async (m: string, p: any) => {
    if (fail && m === "sendMessage") {
      fail = false;
      throw new Error("telegram sendMessage: Too Many Requests");
    }
    return real(m, p);
  };
  tg.notify({ kind: "ready", card: { ...card, summary: "one" } });
  tg.notify({ kind: "ready", card: { ...card, summary: "two" } });
  await tg.flush();
  expect(sent()).toEqual([expect.stringContaining("two")]);
});

test("nothing is sent before the group is linked", async () => {
  await tg.setup("123:abc");
  calls = [];
  tg.notify({ kind: "ready", card });
  await tg.flush();
  expect(calls).toEqual([]);
});

test("your text in a card's topic goes to its agent; others and unknown topics are ignored", async () => {
  await linked();
  tg.notify({ kind: "ready", card });
  await tg.flush();
  calls = [];
  await tg.handle(inTopic(101, "use postgres"));
  await tg.handle(inTopic(101, "hi", 7));
  await tg.handle(inTopic(555, "lost"));
  expect(replies).toEqual([{ id: 5, text: "use postgres" }]);
  expect(calls.map((c) => c.method)).toEqual(["setMessageReaction"]);
});

test("a reply the board refuses comes back in the topic", async () => {
  await linked();
  tg.notify({ kind: "ready", card });
  await tg.flush();
  calls = [];
  replyError = "card #5 has no running agent";
  await tg.handle(inTopic(101, "hello"));
  expect(sent()).toEqual(["Not sent: card #5 has no running agent"]);
});

test("the group keeps working after Telegram upgrades it to a new chat id", async () => {
  await linked();
  await tg.handle({ message_id: 3, chat: { id: CHAT }, migrate_to_chat_id: -1002 });
  tg.notify({ kind: "ready", card });
  await tg.flush();
  expect(calls[0]!.params.chat_id).toBe(-1002);
});

test("polling hands messages over and remembers where it stopped", async () => {
  await linked();
  tg.notify({ kind: "ready", card });
  await tg.flush();
  tg.stop();
  updates = [[{ update_id: 40, message: inTopic(101, "go on") }]];
  tg.start();
  await Bun.sleep(20);
  expect(replies).toEqual([{ id: 5, text: "go on" }]);
  expect(JSON.parse(readFileSync(`${home}/telegram.json`, "utf8")).offset).toBe(41);
});

test("off forgets the bot", async () => {
  await linked();
  expect(tg.disable()).toEqual({ enabled: false });
  expect(board().status()).toEqual({ enabled: false });
  tg.notify({ kind: "ready", card });
  await tg.flush();
  expect(calls).toEqual([]);
});

test("a topic deleted in Telegram is made again", async () => {
  await linked();
  tg.notify({ kind: "ready", card });
  await tg.flush();
  const real = api;
  (tg as any).bot.api = async (m: string, p: any) => {
    if (m === "sendMessage" && p.message_thread_id === 101) throw new Error("telegram sendMessage: Bad Request: message thread not found");
    if (m === "createForumTopic") {
      calls.push({ method: m, params: p });
      return { message_thread_id: 202 };
    }
    return real(m, p);
  };
  calls = [];
  tg.notify({ kind: "ready", card: { ...card, summary: "again" } });
  await tg.flush();
  expect(calls.map((c) => c.method)).toEqual(["createForumTopic", "sendMessage"]);
  expect(calls[1]!.params.message_thread_id).toBe(202);
});

test("an anonymous admin can't link: anyone else posting as the group would be let in", async () => {
  const s = await tg.setup("123:abc");
  await tg.handle({ message_id: 1, chat: { id: CHAT, is_forum: true }, from: { id: 1087968824 }, text: `/link ${s.enabled && !s.linked ? s.code : ""}` });
  expect(tg.status()).toMatchObject({ linked: false });
  expect(sent().at(-1)).toContain("anonymous admin");
});

const general = (text: string, from = ME) => ({ message_id: 9, chat: { id: CHAT }, from: { id: from }, text });

test("/new makes a card in the only project, with the lines after the title as its brief", async () => {
  await linked();
  await tg.handle(general("/new Add dark mode\nUse the theme tokens.\nKeep contrast."));
  expect(cards.at(-1)).toMatchObject({ title: "Add dark mode", brief: "Use the theme tokens.\nKeep contrast.", project_id: 1 });
  expect(sent()).toEqual(["🆕 Created <b>#6</b> in web (todo). Its topic opens when the agent starts."]);
});

test("/new with several projects needs the project first", async () => {
  await linked();
  projects.push({ id: 2, name: "api", path: "/repo/api" } as Project);
  await tg.handle(general("/new Add dark mode"));
  expect(sent()[0]).toContain("start with the project: web, api");
  await tg.handle(general("/new api Rate limit"));
  expect(cards.at(-1)).toMatchObject({ title: "Rate limit", project_id: 2 });
});

test("/cards lists open cards with what their agent is doing", async () => {
  await linked();
  cards.push({ ...card, id: 7, lane: "needs_you", attention: "Which DB?\nmore", agent_status: "idle" }, { ...card, id: 8, lane: "done", agent_status: null });
  await tg.handle(general("/cards"));
  expect(sent()[0]).toBe("⚙️ <b>#5</b> Fix login\n   working · agent working\n\n❓ <b>#7</b> Fix login\n   needs you · agent idle\n   <i>Which DB?</i>");
});

test("/status and /finish act on the topic's card, or the id given", async () => {
  await linked();
  tg.notify({ kind: "started", card: { ...card, brief: "do it" } });
  await tg.flush();
  calls = [];
  await tg.handle(inTopic(101, "/status"));
  expect(sent()[0]).toStartWith("⚙️ <b>#5 Fix login</b>\nworking · agent working");
  expect(sent()[0]).toContain("starting worker");
  expect(replies).toEqual([]);
  await tg.handle(inTopic(101, "/finish"));
  expect(sent().slice(1)).toEqual(["Finishing <b>#5</b>…", "🏁 Finished <b>#5</b>."]);
  expect(cards[0]!.lane).toBe("done");
  await tg.handle(general("/status 99"));
  expect(sent().at(-1)).toBe("no card #99");
});

test("commands answer only the linked user, and ignore ones meant for another bot", async () => {
  await linked();
  await tg.handle(general("/cards", 7));
  await tg.handle(general("/cards@other_bot"));
  expect(calls).toEqual([]);
  await tg.handle(general("/cards@hb_bot"));
  await tg.handle(general("/nope"));
  await tg.handle(general("/constructor"));
  expect(sent()[1]).toContain("Unknown command");
  expect(sent()[2]).toContain("Unknown command");
});

test("/run fires an automation and reports why one can't", async () => {
  await linked();
  await tg.handle(general("/run nightly"));
  await tg.handle(general("/run nope"));
  expect(sent()).toEqual(["▶️ Run started on <b>#5</b>.", "no automation 'nope'"]);
});

test("linking puts the commands in Telegram's menu for that group", async () => {
  const s = await tg.setup("123:abc");
  await tg.handle({ message_id: 1, chat: { id: CHAT, is_forum: true }, from: { id: ME }, text: `/link ${s.enabled && !s.linked ? s.code : ""}` });
  const menu = calls.find((c) => c.method === "setMyCommands")!;
  expect(menu.params.scope).toEqual({ type: "chat", chat_id: CHAT });
  expect(menu.params.commands.map((c: any) => c.command)).toEqual(["new", "cards", "status", "finish", "projects", "run", "help"]);
});

test("a started card opens its topic with the brief", async () => {
  await linked();
  tg.notify({ kind: "started", card: { ...card, brief: "Write hello.txt" } });
  await tg.flush();
  expect(calls.map((c) => c.method)).toEqual(["createForumTopic", "sendMessage"]);
  expect(sent()[0]).toBe("▶️ <b>Started</b>\n<blockquote expandable>Write hello.txt</blockquote>\n<i>/status for progress. Reply here to talk to the agent.</i>");
});

test("a card id must be a number: /finish never falls back to the topic's card on a typo", async () => {
  await linked();
  tg.notify({ kind: "started", card });
  await tg.flush();
  calls = [];
  await tg.handle(inTopic(101, "/finish 12 please"));
  expect(sent()).toEqual(["not a card id: 12 please"]);
  expect(cards[0]!.lane).toBe("working");
  await tg.handle(general("/finish"));
  expect(sent().at(-1)).toBe("which card? /finish &lt;id&gt;, or send it in the card's topic");
});

test("/finish on a finished card says so", async () => {
  await linked();
  cards[0]!.lane = "done";
  await tg.handle(general("/finish 5"));
  expect(sent()).toEqual(["#5 is already finished"]);
});

test("in a card's topic, a slash command the bot doesn't know goes to the agent", async () => {
  await linked();
  tg.notify({ kind: "started", card });
  await tg.flush();
  await tg.handle(inTopic(101, "/compact"));
  await tg.handle(inTopic(101, "/model opus"));
  expect(replies).toEqual([{ id: 5, text: "/compact" }, { id: 5, text: "/model opus" }]);
});

test("markup Telegram refuses is sent again as plain text", async () => {
  await linked();
  const real = api;
  (tg as any).bot.api = async (m: string, p: any) => {
    if (m === "sendMessage" && p.parse_mode) throw new Error("telegram sendMessage: Bad Request: can't parse entities: unsupported start tag");
    return real(m, p);
  };
  tg.notify({ kind: "ready", card: { ...card, summary: "**Done**: fixed `login()`" } });
  await tg.flush();
  const plain = calls.filter((c) => c.method === "sendMessage").at(-1)!.params;
  expect(plain.parse_mode).toBeUndefined();
  expect(plain.text).toBe("✅ Ready\n\nDone: fixed login()\n\nReply here to follow up, or /finish.");
});

test("a reopened card comes back to its topic, reopened", async () => {
  await linked();
  tg.notify({ kind: "started", card });
  tg.notify({ kind: "done", card: { ...card, lane: "done" } });
  tg.notify({ kind: "started", card });
  await tg.flush();
  expect(calls.map((c) => c.method)).toEqual(["createForumTopic", "sendMessage", "closeForumTopic", "reopenForumTopic", "sendMessage"]);
  expect(calls.at(-1)!.params.message_thread_id).toBe(101);
});

test("a deleted card's topic is deleted too", async () => {
  await linked();
  tg.notify({ kind: "started", card });
  tg.notify({ kind: "deleted", card });
  tg.notify({ kind: "deleted", card });
  await tg.flush();
  expect(calls.map((c) => c.method)).toEqual(["createForumTopic", "sendMessage", "deleteForumTopic"]);
  expect(calls.at(-1)!.params).toEqual({ chat_id: CHAT, message_thread_id: 101 });
  expect(JSON.parse(readFileSync(`${home}/telegram.json`, "utf8")).topics).toEqual({});
});
