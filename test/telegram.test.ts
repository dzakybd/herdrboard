import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Card } from "../src/db.ts";
import { Telegram } from "../src/telegram.ts";

const CHAT = -1001;
const ME = 42;
const card = { id: 5, title: "Fix login", lane: "working", summary: null, attention: null, resume_lane: null } as Card;

let home: string;
let calls: { method: string; params: any }[];
let replies: { id: number; text: string }[];
let replyError: string | null;
let updates: any[][]; // each getUpdates call takes the next batch; then it hangs until aborted
let tg: Telegram;

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
const board = () =>
  new Telegram(home, async (id, text) => {
    if (replyError) throw new Error(replyError);
    replies.push({ id, text });
  }, () => api);

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/hb-tg-`);
  calls = [];
  replies = [];
  replyError = null;
  updates = [];
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
  expect(sent()[0]).toContain("Which DB?\n\nReply here to answer.");
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
