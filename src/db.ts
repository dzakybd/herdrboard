import { Database } from "bun:sqlite";

export const LANES = ["backlog", "todo", "working", "review", "needs_you", "ready", "done"] as const;
export type Lane = (typeof LANES)[number];
export type Role = "orchestrator" | "worker" | "reviewer";

export interface Project {
  id: number;
  name: string;
  path: string;
  base: string;
  review: number; // default for new cards
  orchestrator: string | null; // RoleConfig JSON overrides; null = settings default
  worker: string | null;
  reviewer: string | null;
  orch_pane: string | null;
}

export interface Card {
  id: number;
  project_id: number;
  title: string;
  brief: string;
  lane: Lane;
  review: number;
  worktree: number;
  worker: string | null;
  reviewer: string | null;
  automation_id: number | null;
  branch: string | null;
  cwd: string | null;
  workspace_id: string | null;
  tab_id: string | null; // set only for cards without a worktree
  worker_pane: string | null;
  reviewer_pane: string | null;
  round: number;
  worked: number; // active agent was seen working since its last prompt
  attention: string | null; // why the card is in needs_you
  resume_lane: Lane | null; // where needs_you returns to once the agent works again
  summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface Automation {
  id: number;
  name: string;
  project_id: number;
  trigger: string;
  title: string;
  brief: string;
  worktree: number;
  review: number;
  worker: string | null;
  reviewer: string | null;
  enabled: number;
  last_run_at: number;
  created_at: number;
}

export interface CardEvent {
  id: number;
  card_id: number;
  at: number;
  text: string;
}

export interface Profile {
  name: string;
  command: string;
}

export interface RoleConfig {
  profile?: string;
  model?: string;
  effort?: string;
  mode?: string;
}

export interface Settings {
  profiles: Profile[];
  roles: Record<Role, RoleConfig & { profile: string }>;
  maxWorkers: number;
  maxRounds: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  base TEXT NOT NULL DEFAULT 'main',
  review INTEGER NOT NULL DEFAULT 1,
  orchestrator TEXT, worker TEXT, reviewer TEXT,
  orch_pane TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT 'todo',
  review INTEGER NOT NULL DEFAULT 1,
  worktree INTEGER NOT NULL DEFAULT 1,
  worker TEXT, reviewer TEXT,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  branch TEXT, cwd TEXT, workspace_id TEXT, tab_id TEXT,
  worker_pane TEXT, reviewer_pane TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  worked INTEGER NOT NULL DEFAULT 0,
  attention TEXT, resume_lane TEXT, summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  worktree INTEGER NOT NULL DEFAULT 1,
  review INTEGER NOT NULL DEFAULT 1,
  worker TEXT, reviewer TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, string | number | null>;

export class Store {
  readonly db: Database;

  constructor(path: string, defaults: () => Settings) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    if (!this.db.query("SELECT 1 FROM settings WHERE key = 'settings'").get()) this.saveSettings(defaults());
  }

  settings(): Settings {
    const row = this.db.query("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string };
    const s = JSON.parse(row.value);
    // Before model/effort/mode existed, a role was just a profile name.
    for (const [role, cfg] of Object.entries(s.roles)) {
      if (typeof cfg === "string") s.roles[role] = { profile: cfg, mode: "bypassPermissions" };
    }
    return s;
  }

  saveSettings(s: Settings): void {
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify(s));
  }

  projects(): Project[] {
    return this.db.query("SELECT * FROM projects ORDER BY name").all() as Project[];
  }

  project(id: number): Project | null {
    return this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  }

  projectByName(name: string): Project | null {
    return this.db.query("SELECT * FROM projects WHERE name = ?").get(name) as Project | null;
  }

  addProject(p: { name: string; path: string; base: string; review?: number }): Project {
    const row = this.db
      .query("INSERT INTO projects (name, path, base, review) VALUES (?, ?, ?, ?) RETURNING *")
      .get(p.name, p.path, p.base, p.review ?? 1);
    return row as Project;
  }

  updateProject(id: number, patch: Partial<Project>): Project {
    this.update("projects", id, patch);
    return this.project(id)!;
  }

  deleteProject(id: number): void {
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }

  cards(): Card[] {
    return this.db.query("SELECT * FROM cards ORDER BY id").all() as Card[];
  }

  card(id: number): Card | null {
    return this.db.query("SELECT * FROM cards WHERE id = ?").get(id) as Card | null;
  }

  cardsIn(lane: Lane): Card[] {
    return this.db.query("SELECT * FROM cards WHERE lane = ? ORDER BY id").all(lane) as Card[];
  }

  addCard(c: Pick<Card, "project_id" | "title" | "brief" | "lane" | "review" | "worktree"> & Partial<Card>): Card {
    const now = Date.now();
    const row = this.db
      .query(
        `INSERT INTO cards (project_id, title, brief, lane, review, worktree, worker, reviewer, automation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(c.project_id, c.title, c.brief, c.lane, c.review, c.worktree, c.worker ?? null, c.reviewer ?? null, c.automation_id ?? null, now, now) as Card;
    this.log(row.id, `created in ${row.lane}`);
    return row;
  }

  updateCard(id: number, patch: Partial<Card>): Card {
    this.update("cards", id, { ...patch, updated_at: Date.now() });
    return this.card(id)!;
  }

  deleteCard(id: number): void {
    this.db.query("DELETE FROM cards WHERE id = ?").run(id);
  }

  log(cardId: number, text: string): void {
    this.db.query("INSERT INTO events (card_id, at, text) VALUES (?, ?, ?)").run(cardId, Date.now(), text);
  }

  events(cardId: number): CardEvent[] {
    return this.db.query("SELECT * FROM events WHERE card_id = ? ORDER BY id").all(cardId) as CardEvent[];
  }

  automations(): Automation[] {
    return this.db.query("SELECT * FROM automations ORDER BY name").all() as Automation[];
  }

  automation(id: number): Automation | null {
    return this.db.query("SELECT * FROM automations WHERE id = ?").get(id) as Automation | null;
  }

  automationByName(name: string): Automation | null {
    return this.db.query("SELECT * FROM automations WHERE name = ?").get(name) as Automation | null;
  }

  addAutomation(a: Omit<Automation, "id" | "last_run_at" | "created_at" | "enabled"> & { enabled?: number }): Automation {
    return this.db
      .query(
        `INSERT INTO automations (name, project_id, trigger, title, brief, worktree, review, worker, reviewer, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(a.name, a.project_id, a.trigger, a.title, a.brief, a.worktree, a.review, a.worker, a.reviewer, a.enabled ?? 1, Date.now()) as Automation;
  }

  updateAutomation(id: number, patch: Partial<Automation>): Automation {
    this.update("automations", id, patch);
    return this.automation(id)!;
  }

  deleteAutomation(id: number): void {
    this.db.query("DELETE FROM automations WHERE id = ?").run(id);
  }

  private update(table: string, id: number, patch: object): void {
    const entries = Object.entries(patch).filter(([k, v]) => k !== "id" && v !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db.query(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...(entries.map(([, v]) => v) as Row[keyof Row][]), id);
  }
}
