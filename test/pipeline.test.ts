import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { saveAttachments } from "../src/attachments.ts";
import { Store, type Card } from "../src/db.ts";
import type { AgentStatus, Herdr } from "../src/herdr.ts";
import { Pipeline } from "../src/pipeline.ts";

/** In-memory herdr: every launched pane hosts an agent that settles idle. */
class FakeHerdr implements Herdr {
  status = new Map<string, AgentStatus>();
  screen = new Map<string, string>();
  prompts: { target: string; text: string }[] = [];
  commands: { pane: string; command: string }[] = [];
  names = new Map<string, string>(); // name → pane
  removed: string[] = [];
  closed: string[] = [];
  trustOnLaunch = false;
  private n = 0;

  private next(ws: string) {
    const paneId = `${ws}:p${++this.n}`;
    return { workspaceId: ws, tabId: `${ws}:t1`, paneId };
  }
  async worktreeCreate(_repo: string, branch: string) {
    return { ...this.next(`w${this.n + 1}`), path: `/wt/${branch}` };
  }
  async tabIn() {
    return this.next("w0");
  }
  async split(paneId: string) {
    return this.next(paneId.split(":")[0]!).paneId;
  }
  async run(pane: string, command: string) {
    this.commands.push({ pane, command });
    if (this.trustOnLaunch) {
      this.status.set(pane, "blocked");
      this.screen.set(pane, "❯ No, exit\n  Yes, I trust this folder");
    } else this.status.set(pane, "idle");
  }
  async read(pane: string) {
    return this.screen.get(pane) ?? "";
  }
  async agents() {
    return new Map(this.status);
  }
  async sendKeys(pane: string, keys: string[]) {
    if (keys.join(" ") === "down enter") {
      this.screen.delete(pane);
      this.status.set(pane, "idle");
    }
  }
  async rename(pane: string, name: string) {
    this.names.set(name, pane);
  }
  async prompt(target: string, text: string) {
    this.prompts.push({ target, text });
  }
  async focus() {}
  async closePane(pane: string) {
    this.status.delete(pane);
    this.closed.push(pane);
  }
  async closeTab(tab: string) {
    this.closed.push(tab);
  }
  async worktreeRemove(ws: string) {
    this.removed.push(ws);
  }
}

let store: Store;
let herdr: FakeHerdr;
let p: Pipeline;
let projectId: number;
let home: string;

beforeEach(() => {
  store = new Store(":memory:", () => ({
    profiles: [
      { name: "cc2", command: "cc2" },
      { name: "ccd", command: "ccd" },
    ],
    roles: {
      orchestrator: { profile: "cc2", mode: "bypassPermissions" },
      worker: { profile: "cc2", mode: "bypassPermissions" },
      reviewer: { profile: "ccd", model: "sonnet", mode: "bypassPermissions" },
    },
    maxWorkers: 2,
    maxRounds: 2,
  }));
  herdr = new FakeHerdr();
  p = new Pipeline(store, herdr, { home: (home = mkdtempSync(`${tmpdir()}/hb-`)), url: "http://127.0.0.1:7320", pollMs: 1, launchTimeoutMs: 500 });
  projectId = store.addProject({ name: "demo", path: "/repo/demo", base: "main" }).id;
});

const add = (over: Partial<Card> = {}) =>
  store.addCard({ project_id: projectId, title: "Add hello", brief: "write hello.txt", lane: "todo", review: 1, worktree: 1, ...over });

async function started(over: Partial<Card> = {}) {
  const card = add(over);
  await p.tick();
  await p.settle();
  return store.card(card.id)!;
}

describe("worker start", () => {
  test("todo card gets a worktree and a named, prompted worker", async () => {
    const card = await started();
    expect(card.lane).toBe("working");
    expect(card.branch).toBe(`hb/${card.id}-add-hello`);
    expect(card.cwd).toBe(`/wt/hb/${card.id}-add-hello`);
    expect(herdr.commands[0]!.command).toMatch(
      new RegExp(`^HB_CARD=${card.id} HB_ROLE=worker HB_URL=http://127.0.0.1:7320 cc2 --permission-mode bypassPermissions --add-dir '.*/cards/${card.id}'$`),
    );
    expect(herdr.names.get(`hb-${card.id}-worker`)).toBe(card.worker_pane!);
    const brief = herdr.prompts[0]!.text.match(/^Read (\S+) and follow it\.$/)![1]!;
    expect(readFileSync(brief, "utf8")).toContain("write hello.txt");
  });

  test("answers the folder-trust prompt, nothing else", async () => {
    herdr.trustOnLaunch = true;
    const card = await started();
    expect(card.lane).toBe("working");
    expect(herdr.prompts).toHaveLength(1);
  });

  test("card worker override wins over the project and settings", async () => {
    store.updateProject(projectId, { worker: "ccd" });
    await started({ worker: "cc2" });
    expect(herdr.commands[0]!.command).toContain(" cc2 --permission-mode bypassPermissions --add-dir ");
  });

  test("model, effort and mode merge field by field: card → project → settings", async () => {
    store.updateProject(projectId, { worker: JSON.stringify({ profile: "ccd", effort: "high" }) });
    await started({ worker: JSON.stringify({ model: "opus", mode: "plan" }) });
    expect(herdr.commands[0]!.command).toContain(" ccd --model opus --effort high --permission-mode plan --add-dir ");
  });

  test("respects maxWorkers", async () => {
    add();
    add();
    const third = add();
    await p.tick();
    await p.settle();
    expect(store.card(third.id)!.lane).toBe("todo");
  });

  test("no-worktree card runs in a tab of the main checkout", async () => {
    const card = await started({ worktree: 0 });
    expect(card.cwd).toBe("/repo/demo");
    expect(card.tab_id).toBe("w0:t1");
    expect(card.branch).toBeNull();
  });

  test("launch failure lands in needs_you", async () => {
    herdr.run = async () => {
      throw new Error("pane gone");
    };
    const card = await started();
    expect(card.lane).toBe("needs_you");
    expect(card.attention).toContain("pane gone");
  });
});

describe("review loop", () => {
  test("review off: done goes straight to ready", async () => {
    const card = await started({ review: 0 });
    expect(p.done(card.id, "wrote it").lane).toBe("ready");
  });

  test("approve: done → review (reviewer split) → ready", async () => {
    const card = await started();
    p.done(card.id, "wrote it");
    await p.settle();
    const inReview = store.card(card.id)!;
    expect(inReview.lane).toBe("review");
    expect(herdr.commands[1]!.command).toContain("HB_ROLE=reviewer");
    expect(herdr.commands[1]!.command).toContain(" ccd --model sonnet --permission-mode bypassPermissions --add-dir ");
    expect((await p.review(card.id, true)).lane).toBe("ready");
    expect(herdr.closed).toContain(inReview.reviewer_pane!);
  });

  test("changes go back to the worker, then needs_you after maxRounds", async () => {
    const card = await started();
    for (const round of [1, 2]) {
      p.done(card.id, "try");
      await p.settle();
      const after = await p.review(card.id, false, "fix the typo");
      expect(after.lane).toBe("working");
      expect(after.round).toBe(round);
      expect(herdr.prompts.at(-1)!.target).toBe(card.worker_pane!);
      expect(herdr.prompts.at(-1)!.text).toContain("fix the typo");
    }
    p.done(card.id, "try");
    await p.settle();
    const failed = await p.review(card.id, false, "still wrong");
    expect(failed.lane).toBe("needs_you");
    expect(failed.attention).toContain("still wrong");
    expect(failed.resume_lane).toBe("working");
  });

  test("done from the wrong lane is rejected", async () => {
    const card = add({ lane: "backlog" });
    expect(() => p.done(card.id, "x")).toThrow("not working");
  });
});

describe("agent state sync", () => {
  test("blocked → needs_you, working again → back", async () => {
    const card = await started();
    herdr.status.set(card.worker_pane!, "blocked");
    await p.sync();
    expect(store.card(card.id)!.lane).toBe("needs_you");
    herdr.status.set(card.worker_pane!, "working");
    await p.sync();
    expect(store.card(card.id)!.lane).toBe("working");
  });

  test("stopping without hb done needs you, but not before it ever worked", async () => {
    const card = await started();
    await p.sync(); // idle right after the prompt: not worked yet
    expect(store.card(card.id)!.lane).toBe("working");
    herdr.status.set(card.worker_pane!, "working");
    await p.sync();
    herdr.status.set(card.worker_pane!, "done");
    await p.sync();
    expect(store.card(card.id)!.attention).toContain("hb done");
  });

  test("a stop says why, from the agent's screen", async () => {
    const card = await started();
    await p.sync();
    herdr.status.set(card.worker_pane!, "working");
    await p.sync();
    herdr.status.set(card.worker_pane!, "idle");
    herdr.screen.set(card.worker_pane!, "❯ Read brief\n  ⎿  You've hit your 5-hour limit · resets 12:10pm (Asia/Jakarta)\n⏺ Usage limit reached");
    await p.sync();
    const stuck = store.card(card.id)!;
    expect(stuck.lane).toBe("needs_you");
    expect(stuck.attention).toStartWith("cc2 hit its 5-hour usage limit (resets 12:10pm).");
  });

  test("agent exit needs you", async () => {
    const card = await started();
    herdr.status.delete(card.worker_pane!);
    await p.sync();
    expect(store.card(card.id)!.attention).toBe("The agent (cc2) exited and its pane is gone.");
  });

  test("hb ask waits out the asking turn, returns once the agent is answered", async () => {
    const card = await started();
    herdr.status.set(card.worker_pane!, "working");
    p.ask(card.id, "Which color?");
    await p.sync(); // still finishing the turn that ran `hb ask`
    expect(store.card(card.id)!.lane).toBe("needs_you");
    herdr.status.set(card.worker_pane!, "done");
    await p.sync();
    expect(store.card(card.id)!.attention).toBe("Which color?");
    herdr.status.set(card.worker_pane!, "working"); // answered
    await p.sync();
    expect(store.card(card.id)!.lane).toBe("working");
  });

  test("hb ask, then reply prompts the agent", async () => {
    const card = await started();
    p.ask(card.id, "Which color?");
    expect(store.card(card.id)!.lane).toBe("needs_you");
    await p.reply(card.id, "blue");
    expect(herdr.prompts.at(-1)).toEqual({ target: card.worker_pane!, text: "blue" });
  });
});

describe("attachments and replies in Ready", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64");

  test("attached files are listed in the worker's brief", async () => {
    const card = add();
    saveAttachments(home, card.id, [{ name: "my shot (1).png", data: b64("png") }]);
    await p.tick();
    await p.settle();
    const brief = readFileSync(`${home}/cards/${card.id}/worker.md`, "utf8");
    expect(brief).toContain("## Attachments");
    expect(brief).toContain(`${home}/cards/${card.id}/attachments/my_shot_1_.png`);
  });

  test("a ready card still takes a reply, with files, and goes back to working", async () => {
    const card = await started({ review: 0 });
    p.done(card.id, "done");
    expect(store.card(card.id)!.lane).toBe("ready");
    await p.reply(card.id, "yes, also do X", [{ name: "spec.pdf", data: b64("pdf") }]);
    const sent = herdr.prompts.at(-1)!;
    expect(sent.target).toBe(card.worker_pane!);
    expect(sent.text).toContain("yes, also do X");
    expect(sent.text).toContain(`${home}/cards/${card.id}/attachments/spec.pdf`);
    expect(store.card(card.id)!.lane).toBe("working");
    expect(p.done(card.id, "did X").lane).toBe("ready");
  });

  test("hb ask from a ready card waits for you, and the answer puts it back to working", async () => {
    const card = await started({ review: 0 });
    p.done(card.id, "done");
    p.ask(card.id, "Want me to also clean up?");
    expect(store.card(card.id)).toMatchObject({ lane: "needs_you", resume_lane: "working" });
    herdr.status.set(card.worker_pane!, "idle");
    await p.sync();
    await p.reply(card.id, "yes");
    herdr.status.set(card.worker_pane!, "working");
    await p.sync();
    expect(store.card(card.id)!.lane).toBe("working");
  });

  test("a follow-up from ready can skip or repeat the review", async () => {
    const card = await started({ review: 1 });
    p.done(card.id, "done");
    await p.review(card.id, true); // reviewer approves, card is ready
    await p.reply(card.id, "also rename it", undefined, false);
    expect(store.card(card.id)).toMatchObject({ lane: "working", review: 0 });
    expect(p.done(card.id, "renamed").lane).toBe("ready"); // no second reviewer round
    await p.reply(card.id, "one more, check it", undefined, true);
    expect(p.done(card.id, "again").lane).toBe("review");
  });

  test("a reply from ready waits when every worker slot is busy", async () => {
    const card = await started({ review: 0 });
    p.done(card.id, "done");
    add({ lane: "working" });
    add({ lane: "working" });
    await expect(p.reply(card.id, "more")).rejects.toThrow("worker slots are busy");
    expect(store.card(card.id)!.lane).toBe("ready");
  });

  test("an empty reply is refused", async () => {
    const card = await started();
    await expect(p.reply(card.id, "  ")).rejects.toThrow("write a message or attach a file");
  });
});

describe("drain", () => {
  test("waits for a launch in flight, then starts nothing new", async () => {
    const run = herdr.run.bind(herdr);
    herdr.run = async (pane, command) => {
      await Bun.sleep(40);
      return run(pane, command);
    };
    const card = add();
    p.startQueued(); // launch begins, not finished
    expect(await p.drain(2000)).toBe(true);
    expect(store.card(card.id)!.worker_pane).not.toBeNull();
    expect(herdr.prompts).toHaveLength(1); // the brief was delivered before drain returned
    const later = add({ title: "later" });
    await p.tick();
    expect(store.card(later.id)!.lane).toBe("todo");
  });

  test("gives up after the deadline instead of hanging", async () => {
    herdr.run = () => new Promise(() => {});
    add();
    p.startQueued();
    expect(await p.drain(60)).toBe(false);
  });
});

describe("recover", () => {
  test("a card cut off mid-launch goes to needs_you", () => {
    const card = add({ lane: "working" });
    p.recover();
    expect(store.card(card.id)!.attention).toContain("restarted");
  });
});

describe("moves and finish", () => {
  test("backlog ⇄ todo only before start; done removes the worktree", async () => {
    const parked = add({ lane: "backlog" });
    expect((await p.move(parked.id, "todo")).lane).toBe("todo");
    const card = await started();
    await expect(p.move(card.id, "todo")).rejects.toThrow();
    const done = await p.move(card.id, "done");
    expect(done.lane).toBe("done");
    expect(herdr.removed).toEqual([card.workspace_id!]);
  });
});

describe("finish cleanup", () => {
  test("runs after the worktree is gone, logs its notes, and a throw does not stop Finish", async () => {
    const seen: number[] = [];
    let boom = false;
    const q = new Pipeline(store, herdr, {
      home: mkdtempSync(`${tmpdir()}/hb-`),
      url: "http://127.0.0.1:7320",
      pollMs: 1,
      launchTimeoutMs: 500,
      cleanup: async (c) => {
        seen.push(herdr.removed.length);
        if (boom) throw new Error("disk on fire");
        return ["cleanup note"];
      },
    });
    const a = add();
    await q.tick();
    await q.settle();
    expect((await q.finish(a.id)).lane).toBe("done");
    expect(seen).toEqual([1]);
    expect(store.events(a.id).map((e) => e.text)).toContain("cleanup note");

    boom = true;
    const b = add();
    await q.tick();
    await q.settle();
    expect((await q.finish(b.id)).lane).toBe("done");
    expect(store.events(b.id).map((e) => e.text)).toContain("cleanup failed: disk on fire");
  });
});

describe("folder projects", () => {
  test("a card runs in the folder and Finish closes its tab", async () => {
    const folder = store.addProject({ name: "many", path: "/repos", base: "" });
    const home = mkdtempSync(`${tmpdir()}/hb-`);
    const q = new Pipeline(store, herdr, { home, url: "http://127.0.0.1:7320", pollMs: 1, launchTimeoutMs: 500 });
    const card = add({ project_id: folder.id, review: 0 });
    await q.tick();
    await q.settle();
    const running = store.card(card.id)!;
    expect(running).toMatchObject({ worktree: 0, branch: null, cwd: "/repos" });
    expect(readFileSync(`${home}/cards/${card.id}/worker.md`, "utf8")).toContain(`/repos/.hb-worktrees/${card.id}/<repo>`);
    await q.finish(card.id);
    expect(herdr.removed).toEqual([]);
    expect(herdr.closed).toContain(running.tab_id!);
  });
});

describe("automations", () => {
  const sweep = () => store.addAutomation({ name: "sweep", project_id: projectId, trigger: "every 1m", title: "Sweep", brief: "b", worktree: 0, review: 0, worker: null, reviewer: null });

  test("fires a todo card, skips while it is in progress", async () => {
    const a = sweep();
    const t0 = a.created_at + 60_000;
    await p.runAutomations(t0);
    expect(store.cardsIn("todo").map((c) => c.title)).toEqual(["Sweep"]);
    await p.runAutomations(t0 + 60_000);
    expect(store.cards()).toHaveLength(1);
  });

  test("the next fire reuses the Ready card's agent: same card, brief sent again", async () => {
    const a = sweep();
    const first = (await p.fire(a))!;
    await p.tick();
    await p.settle();
    const pane = store.card(first.id)!.worker_pane!;
    p.done(first.id, "swept 3 files");
    store.updateAutomation(a.id, { brief: "sweep harder" });
    const again = (await p.fire(store.automation(a.id)!))!;
    expect(again.id).toBe(first.id);
    expect(again.lane).toBe("working");
    expect(store.cards()).toHaveLength(1);
    const last = herdr.prompts.at(-1)!;
    expect(last.target).toBe(pane);
    expect(last.text).toContain("is due again (run 2)");
    const brief = last.text.match(/Read (\S+) again/)![1]!;
    expect(readFileSync(brief, "utf8")).toContain("sweep harder");
    p.done(first.id, "swept 1 file");
    expect(store.runs(a.id).map((r) => r.summary)).toEqual(["swept 1 file", "swept 3 files"]);
  });

  async function readyRun() {
    const a = sweep();
    const card = (await p.fire(a))!;
    await p.tick();
    await p.settle();
    p.done(card.id, "ok");
    return { a, card: store.card(card.id)! };
  }

  test("a rerun that can't start stays due and runs on a later fire", async () => {
    const { a, card } = await readyRun();
    const others = [add(), add()].map((c) => store.updateCard(c.id, { lane: "working" }));
    const due = store.automation(a.id)!.last_run_at;
    expect(await p.fire(a, Date.now())).toBeNull();
    expect(await p.fire(a, Date.now())).toBeNull();
    expect(store.automation(a.id)!.last_run_at).toBe(due);
    expect(store.events(card.id).filter((e) => e.text.includes("waiting: all 2 worker slots are busy"))).toHaveLength(1);
    store.updateCard(others[0]!.id, { lane: "done" });
    expect((await p.fire(a))!.lane).toBe("working");
  });

  test("a rerun never types into an agent that is busy or asking something", async () => {
    const { a, card } = await readyRun();
    const prompts = herdr.prompts.length;
    herdr.status.set(card.worker_pane!, "blocked");
    expect(await p.fire(a)).toBeNull();
    expect(herdr.prompts).toHaveLength(prompts);
    expect(store.events(card.id).at(-1)!.text).toContain("waiting: the agent is blocked");
  });

  test("two fires at once prompt the agent once", async () => {
    const { a } = await readyRun();
    const prompts = herdr.prompts.length;
    const [x, y] = await Promise.all([p.fire(a), p.fire(a)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(herdr.prompts).toHaveLength(prompts + 1);
  });

  test("a card from before runs were recorded keeps its first run in history", async () => {
    const { a, card } = await readyRun();
    store.transaction(() => {
      (store as any).data.runs = [];
    });
    store.updateCard(card.id, { summary: "the first run" });
    await p.fire(a);
    expect(herdr.prompts.at(-1)!.text).toContain("(run 2)");
    expect(store.runs(a.id).map((r) => r.summary)).toEqual([null, "the first run"]);
  });

  test("the next fire finishes a Ready card whose agent is gone and replaces it", async () => {
    const a = sweep();
    const first = (await p.fire(a))!;
    store.updateCard(first.id, { lane: "ready" });
    const second = (await p.fire(a))!;
    expect(store.card(first.id)!.lane).toBe("done");
    expect(second.lane).toBe("todo");
  });

  test("a Ready card that can't be finished stays, and the fire is skipped", async () => {
    const a = sweep();
    const first = (await p.fire(a))!;
    store.updateCard(first.id, { lane: "ready", worktree: 1, workspace_id: "w9" });
    herdr.worktreeRemove = async () => {
      throw new Error("uncommitted changes");
    };
    expect(await p.fire(a)).toBeNull();
    expect(store.card(first.id)!.lane).toBe("ready");
    expect(store.cards()).toHaveLength(1);
    expect(store.card(first.id)!.attention).toContain("uncommitted changes");
    expect(p.blocked(a)).toMatchObject({ card_id: first.id, reason: expect.stringContaining("uncommitted changes") });
  });

  test("a later successful finish clears the block", async () => {
    const a = sweep();
    const first = (await p.fire(a))!;
    store.updateCard(first.id, { lane: "ready", worktree: 1, workspace_id: "w9" });
    let fail = true;
    herdr.worktreeRemove = async () => {
      if (fail) throw new Error("uncommitted changes");
    };
    await p.fire(a);
    fail = false;
    expect((await p.fire(a))!.lane).toBe("todo");
    expect(store.card(first.id)!.attention).toBeNull();
    expect(p.blocked(a)).toBeNull();
  });

  test("blocked reports an open needs_you card, not working or Ready without attention", async () => {
    const a = sweep();
    expect(p.blocked(a)).toBeNull();
    const c = (await p.fire(a))!;
    store.updateCard(c.id, { lane: "working" });
    expect(p.blocked(a)).toBeNull();
    const asked = store.updateCard(c.id, { lane: "needs_you", attention: "which branch?" });
    expect(p.blocked(a)).toEqual({ card_id: c.id, reason: "which branch?", since: asked.updated_at });
    store.updateCard(c.id, { lane: "ready", attention: null });
    expect(p.blocked(a)).toBeNull();
  });

  test("automationCards lists newest first, capped", async () => {
    const a = sweep();
    const first = (await p.fire(a))!;
    store.updateCard(first.id, { lane: "ready" });
    const second = (await p.fire(a))!;
    expect(store.automationCards(a.id).map((c) => c.id)).toEqual([second.id, first.id]);
    expect(store.automationCards(a.id, 1)).toHaveLength(1);
  });
});

describe("notify", () => {
  test("tells about needs_you, ready and done, in order", async () => {
    const events: string[] = [];
    p = new Pipeline(store, herdr, { home, url: "http://127.0.0.1:7320", pollMs: 1, launchTimeoutMs: 500, notify: (e) => events.push(`${e.kind}: ${e.card.attention ?? e.card.summary}`) });
    const card = await started({ review: 0 });
    p.ask(card.id, "which db?");
    herdr.status.set(card.worker_pane!, "idle");
    await p.sync();
    herdr.status.set(card.worker_pane!, "working");
    await p.sync();
    p.done(card.id, "done");
    await p.finish(card.id);
    expect(events).toEqual(["started: null", "needs_you: which db?", "ready: done", "done: done"]);
  });

  test("a failed launch tells too", async () => {
    const events: string[] = [];
    p = new Pipeline(store, herdr, { home, url: "http://127.0.0.1:7320", pollMs: 1, launchTimeoutMs: 500, notify: (e) => events.push(`${e.kind}: ${e.card.attention}`) });
    herdr.run = async () => {
      throw new Error("pane gone");
    };
    await started();
    expect(events).toEqual(["started: null", "needs_you: Launch failed: pane gone"]);
  });
});
