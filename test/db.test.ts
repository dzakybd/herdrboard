import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/db.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { defaultSettings } from "../src/profiles.ts";

const dir = () => mkdtempSync(`${tmpdir()}/hb-db-`);
const open = (path: string) => new Store(path, () => defaultSettings("/nonexistent"));

test("state survives a reopen and is plain JSON", () => {
  const path = `${dir()}/herdrboard.json`;
  const s = open(path);
  const p = s.addProject({ name: "demo", path: "/repo/demo", base: "main" });
  const c = s.addCard({ project_id: p.id, title: "Hello", brief: "", lane: "todo", review: 1, worktree: 1 });
  s.updateCard(c.id, { lane: "working" });
  const again = open(path);
  expect(again.card(c.id)!.lane).toBe("working");
  expect(again.events(c.id).map((e) => e.text)).toEqual(["created in todo"]);
  expect(JSON.parse(readFileSync(path, "utf8")).cards[0].title).toBe("Hello");
});

test("returned rows are copies", () => {
  const s = open(":memory:");
  const p = s.addProject({ name: "demo", path: "/repo/demo", base: "main" });
  p.name = "changed";
  expect(s.project(p.id)!.name).toBe("demo");
});

test("a failed transaction keeps nothing", () => {
  const path = `${dir()}/herdrboard.json`;
  const s = open(path);
  expect(() =>
    s.transaction(() => {
      s.addProject({ name: "a", path: "/a", base: "main" });
      s.addProject({ name: "a", path: "/b", base: "main" });
    }),
  ).toThrow("a project named 'a' already exists");
  expect(s.projects()).toEqual([]);
  expect(open(path).projects()).toEqual([]);
});

test("deleting a project takes its cards, events and automations; ids are not reused", () => {
  const s = open(":memory:");
  const p = s.addProject({ name: "demo", path: "/repo/demo", base: "main" });
  const keep = s.addProject({ name: "other", path: "/repo/other", base: "main" });
  const c = s.addCard({ project_id: p.id, title: "x", brief: "", lane: "todo", review: 1, worktree: 1 });
  s.addAutomation({ name: "nightly", project_id: p.id, trigger: "daily 09:00", title: "t", brief: "", worktree: 1, review: 1, worker: null, reviewer: null });
  s.deleteProject(p.id);
  expect(s.cards()).toEqual([]);
  expect(s.events(c.id)).toEqual([]);
  expect(s.automations()).toEqual([]);
  expect(s.addCard({ project_id: keep.id, title: "y", brief: "", lane: "todo", review: 1, worktree: 1 }).id).toBe(c.id + 1);
});

test("an old SQLite board moves to JSON once, and the database is set aside", () => {
  const d = dir();
  const db = new Database(`${d}/herdrboard.db`, { create: true });
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT, base TEXT, review INTEGER, orchestrator TEXT, worker TEXT, reviewer TEXT, orch_pane TEXT);
    CREATE TABLE cards (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, brief TEXT, lane TEXT, review INTEGER, worktree INTEGER, worker TEXT, reviewer TEXT, automation_id INTEGER,
      branch TEXT, cwd TEXT, workspace_id TEXT, tab_id TEXT, worker_pane TEXT, reviewer_pane TEXT, round INTEGER, worked INTEGER, attention TEXT, resume_lane TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, card_id INTEGER, at INTEGER, text TEXT);
    CREATE TABLE automations (id INTEGER PRIMARY KEY, name TEXT, project_id INTEGER, trigger TEXT, title TEXT, brief TEXT, worktree INTEGER, review INTEGER, worker TEXT, reviewer TEXT, enabled INTEGER, last_run_at INTEGER, created_at INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO projects VALUES (3, 'demo', '/repo/demo', 'main', 1, NULL, NULL, NULL, NULL);
    INSERT INTO cards VALUES (5, 3, 'Old card', '', 'ready', 1, 1, NULL, NULL, NULL, 'hb/5', '/wt', 'w1', NULL, 'w1:p1', NULL, 0, 1, NULL, NULL, 'did it', 1, 2);
    INSERT INTO events VALUES (11, 5, 1, 'created in todo');
    INSERT INTO settings VALUES ('settings', '{"profiles":[],"roles":{"worker":"cc2"},"maxWorkers":3,"maxRounds":2}');
  `);
  db.close();
  expect(migrateSqlite(`${d}/herdrboard.db`, `${d}/herdrboard.json`)).toBe(true);
  expect(existsSync(`${d}/herdrboard.db`)).toBe(false);
  expect(existsSync(`${d}/herdrboard.db.migrated`)).toBe(true);
  const s = open(`${d}/herdrboard.json`);
  expect(s.card(5)).toMatchObject({ title: "Old card", lane: "ready", summary: "did it", worker_pane: "w1:p1" });
  expect(s.events(5).map((e) => e.text)).toEqual(["created in todo"]);
  expect(s.settings().maxWorkers).toBe(3);
  expect(s.addCard({ project_id: 3, title: "new", brief: "", lane: "todo", review: 1, worktree: 1 }).id).toBe(6);
  expect(migrateSqlite(`${d}/herdrboard.db`, `${d}/herdrboard.json`)).toBe(false);
});

test("deleting an automation keeps its cards, unlinked", () => {
  const s = open(":memory:");
  const p = s.addProject({ name: "demo", path: "/repo/demo", base: "main" });
  const a = s.addAutomation({ name: "nightly", project_id: p.id, trigger: "daily 09:00", title: "t", brief: "", worktree: 1, review: 1, worker: null, reviewer: null });
  const c = s.addCard({ project_id: p.id, title: "run", brief: "", lane: "done", review: 1, worktree: 1, automation_id: a.id });
  s.deleteAutomation(a.id);
  expect(s.card(c.id)!.automation_id).toBeNull();
});

test("a project path can't be registered twice", () => {
  const s = open(":memory:");
  s.addProject({ name: "a", path: "/repo", base: "main" });
  expect(() => s.addProject({ name: "b", path: "/repo", base: "main" })).toThrow("/repo is already the project 'a'");
});

test("a damaged state file stops the board with a message naming it", () => {
  const path = `${dir()}/herdrboard.json`;
  writeFileSync(path, '{"cards": [');
  expect(() => open(path)).toThrow(`can't read ${path}`);
});
