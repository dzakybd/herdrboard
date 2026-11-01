import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  p = new Pipeline(store, herdr, { home: mkdtempSync(`${tmpdir()}/hb-`), url: "http://127.0.0.1:7420", pollMs: 1, launchTimeoutMs: 500 });
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
      new RegExp(`^HB_CARD=${card.id} HB_ROLE=worker HB_URL=http://127.0.0.1:7420 cc2 --permission-mode bypassPermissions --add-dir '.*/cards/${card.id}'$`),
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

  test("agent exit needs you", async () => {
    const card = await started();
    herdr.status.delete(card.worker_pane!);
    await p.sync();
    expect(store.card(card.id)!.attention).toBe("The agent exited.");
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
      url: "http://127.0.0.1:7420",
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
    const q = new Pipeline(store, herdr, { home, url: "http://127.0.0.1:7420", pollMs: 1, launchTimeoutMs: 500 });
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

  test("the next fire finishes a Ready card and replaces it", async () => {
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
