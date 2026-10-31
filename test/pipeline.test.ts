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

describe("automations", () => {
  test("fires a todo card, skips while it is open", () => {
    const a = store.addAutomation({ name: "sweep", project_id: projectId, trigger: "every 1m", title: "Sweep", brief: "b", worktree: 0, review: 0, worker: null, reviewer: null });
    const t0 = a.created_at + 60_000;
    p.runAutomations(t0);
    expect(store.cardsIn("todo").map((c) => c.title)).toEqual(["Sweep"]);
    p.runAutomations(t0 + 60_000);
    expect(store.cards()).toHaveLength(1);
    store.updateCard(store.cards()[0]!.id, { lane: "done" });
    p.runAutomations(t0 + 120_000);
    expect(store.cards()).toHaveLength(2);
  });
});
