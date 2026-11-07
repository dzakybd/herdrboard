import { existsSync } from "node:fs";
import { readJson, writeJson } from "./fs.ts";

export const LANES = ["backlog", "todo", "working", "review", "needs_you", "ready", "done"] as const;
export type Lane = (typeof LANES)[number];
export type Role = "orchestrator" | "worker" | "reviewer";

export interface Project {
  id: number;
  name: string;
  path: string;
  base: string; // empty: a folder of repositories, not a repository itself
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
  /** CardVerdicts JSON from the last `hb done --pr`: the board offers to submit these on GitHub. */
  prs: string | null;
  quiet: number; // the last `hb done` asked not to be announced (nothing to report)
  created_at: number;
  updated_at: number;
}

/** A PR a run reviewed, and what the agent recommends. */
export interface PullVerdict {
  repo: string; // owner/name
  number: number;
  verdict: "approve" | "changes";
}

/** One run's verdicts. `key` is new each `hb done`, so a button from an earlier run can't act on this one. */
export interface CardVerdicts {
  key: string;
  list: (PullVerdict & { submitted?: PullVerdict["verdict"] })[];
}

export function cardVerdicts(card: Pick<Card, "prs"> | null | undefined): CardVerdicts | null {
  try {
    const v = card?.prs ? JSON.parse(card.prs) : null;
    return v && typeof v.key === "string" && Array.isArray(v.list) ? v : null;
  } catch {
    return null;
  }
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

/** One fire of an automation. Runs of a kept-alive agent share one card. */
export interface Run {
  id: number;
  automation_id: number;
  card_id: number;
  at: number;
  summary: string | null; // the worker's `hb done` for this run
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

/** Everything herdrboard keeps, as one JSON file (`~/.herdrboard/herdrboard.json`). */
export interface Data {
  version: 1;
  /** Next id per kind. Ids are never reused, so a new card can't inherit an old card's folder or topic. */
  next: { project: number; card: number; event: number; automation: number; run: number };
  settings: Settings | null;
  projects: Project[];
  cards: Card[];
  events: CardEvent[];
  automations: Automation[];
  runs: Run[];
}

export const empty = (): Data => ({
  version: 1,
  next: { project: 1, card: 1, event: 1, automation: 1, run: 1 },
  settings: null,
  projects: [],
  cards: [],
  events: [],
  automations: [],
  runs: [],
});

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class Store {
  private data: Data;
  private batching = false;

  /** `path` is a JSON file, or ":memory:" for a store that is never written (tests). */
  constructor(
    private path: string,
    defaults: () => Settings,
  ) {
    this.data = path !== ":memory:" && existsSync(path) ? readJson<Data>(path) : empty();
    // Files written before runs existed.
    this.data.runs ??= [];
    this.data.next.run ??= 1;
    if (!this.data.settings) this.saveSettings(defaults());
  }

  /** Runs `fn` as one write: if it throws, nothing it changed is kept. */
  transaction<T>(fn: () => T): T {
    if (this.batching) return fn();
    const before = structuredClone(this.data);
    this.batching = true;
    try {
      const out = fn();
      this.batching = false;
      this.persist();
      return out;
    } catch (e) {
      this.data = before;
      throw e;
    } finally {
      this.batching = false;
    }
  }

  settings(): Settings {
    const s = structuredClone(this.data.settings!) as any;
    // Before model/effort/mode existed, a role was just a profile name.
    for (const [role, cfg] of Object.entries(s.roles)) {
      if (typeof cfg === "string") s.roles[role] = { profile: cfg, mode: "bypassPermissions" };
    }
    return s;
  }

  saveSettings(s: Settings): void {
    this.data.settings = structuredClone(s);
    this.persist();
  }

  projects(): Project[] {
    return this.data.projects.map((p) => ({ ...p })).sort(byName);
  }

  project(id: number): Project | null {
    return copy(this.data.projects.find((p) => p.id === id));
  }

  projectByName(name: string): Project | null {
    return copy(this.data.projects.find((p) => p.name === name));
  }

  addProject(p: { name: string; path: string; base: string; review?: number }): Project {
    this.unique(p.name, p.path);
    const row: Project = { id: this.data.next.project++, name: p.name, path: p.path, base: p.base, review: p.review ?? 1, orchestrator: null, worker: null, reviewer: null, orch_pane: null };
    this.data.projects.push(row);
    this.persist();
    return { ...row };
  }

  updateProject(id: number, patch: Partial<Project>): Project {
    const row = this.data.projects.find((p) => p.id === id);
    if (row) this.unique(patch.name ?? row.name, patch.path ?? row.path, id);
    return this.patch(this.data.projects, id, patch);
  }

  deleteProject(id: number): void {
    this.transaction(() => {
      for (const c of this.data.cards.filter((c) => c.project_id === id)) this.deleteCard(c.id);
      for (const a of this.data.automations.filter((a) => a.project_id === id)) this.deleteAutomation(a.id);
      this.data.projects = this.data.projects.filter((p) => p.id !== id);
    });
  }

  cards(): Card[] {
    return this.data.cards.map((c) => ({ ...c }));
  }

  card(id: number): Card | null {
    return copy(this.data.cards.find((c) => c.id === id));
  }

  cardsIn(lane: Lane): Card[] {
    return this.data.cards.filter((c) => c.lane === lane).map((c) => ({ ...c }));
  }

  addCard(c: Pick<Card, "project_id" | "title" | "brief" | "lane" | "review" | "worktree"> & Partial<Card>): Card {
    const now = Date.now();
    const row = this.newCard({ ...c, created_at: now, updated_at: now });
    this.log(row.id, `created in ${row.lane}`);
    return { ...row };
  }

  /** Restores a card from an export, keeping its timestamps and activity. */
  importCard(c: Pick<Card, "project_id" | "title" | "brief" | "lane" | "review" | "worktree" | "worker" | "reviewer" | "automation_id" | "branch" | "summary" | "created_at" | "updated_at"> & { events: Pick<CardEvent, "at" | "text">[] }): void {
    this.transaction(() => {
      const { events, ...fields } = c;
      const row = this.newCard(fields);
      for (const e of events) this.data.events.push({ id: this.data.next.event++, card_id: row.id, at: e.at, text: e.text });
    });
  }

  updateCard(id: number, patch: Partial<Card>): Card {
    return this.patch(this.data.cards, id, { ...patch, updated_at: Date.now() });
  }

  deleteCard(id: number): void {
    this.data.cards = this.data.cards.filter((c) => c.id !== id);
    this.data.events = this.data.events.filter((e) => e.card_id !== id);
    this.data.runs = this.data.runs.filter((r) => r.card_id !== id);
    this.persist();
  }

  /** An automation's cards, newest first. */
  automationCards(automationId: number, limit = 50): Card[] {
    return this.data.cards
      .filter((c) => c.automation_id === automationId)
      .reverse()
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  log(cardId: number, text: string): void {
    this.data.events.push({ id: this.data.next.event++, card_id: cardId, at: Date.now(), text });
    this.persist();
  }

  events(cardId: number): CardEvent[] {
    return this.data.events.filter((e) => e.card_id === cardId).map((e) => ({ ...e }));
  }

  automations(): Automation[] {
    return this.data.automations.map((a) => ({ ...a })).sort(byName);
  }

  automation(id: number): Automation | null {
    return copy(this.data.automations.find((a) => a.id === id));
  }

  automationByName(name: string): Automation | null {
    return copy(this.data.automations.find((a) => a.name === name));
  }

  addAutomation(a: Omit<Automation, "id" | "last_run_at" | "created_at" | "enabled"> & { enabled?: number }): Automation {
    if (this.data.automations.some((x) => x.name === a.name)) throw new Error(`an automation named '${a.name}' already exists`);
    const row: Automation = { ...a, id: this.data.next.automation++, enabled: a.enabled ?? 1, last_run_at: 0, created_at: Date.now() };
    this.data.automations.push(row);
    this.persist();
    return { ...row };
  }

  updateAutomation(id: number, patch: Partial<Automation>): Automation {
    return this.patch(this.data.automations, id, patch);
  }

  deleteAutomation(id: number): void {
    this.data.automations = this.data.automations.filter((a) => a.id !== id);
    this.data.runs = this.data.runs.filter((r) => r.automation_id !== id);
    for (const c of this.data.cards) if (c.automation_id === id) c.automation_id = null;
    this.persist();
  }

  addRun(automationId: number, cardId: number, at: number, summary: string | null = null): void {
    this.data.runs.push({ id: this.data.next.run++, automation_id: automationId, card_id: cardId, at, summary });
    this.persist();
  }

  runCount(cardId: number): number {
    return this.data.runs.filter((r) => r.card_id === cardId).length;
  }

  /** Puts the summary on the card's latest run, if the card belongs to an automation. */
  endRun(cardId: number, summary: string): void {
    const run = this.data.runs.findLast((r) => r.card_id === cardId);
    if (!run) return;
    run.summary = summary;
    this.persist();
  }

  /** An automation's runs, newest first. */
  runs(automationId: number, limit = 50): Run[] {
    return this.data.runs
      .filter((r) => r.automation_id === automationId)
      .reverse()
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  private newCard(c: Pick<Card, "project_id" | "title" | "brief" | "lane" | "review" | "worktree" | "created_at" | "updated_at"> & Partial<Card>): Card {
    if (!this.data.projects.some((p) => p.id === c.project_id)) throw new Error(`no project #${c.project_id}`);
    const row: Card = {
      id: this.data.next.card++,
      project_id: c.project_id,
      title: c.title,
      brief: c.brief,
      lane: c.lane,
      review: c.review,
      worktree: c.worktree,
      worker: c.worker ?? null,
      reviewer: c.reviewer ?? null,
      automation_id: c.automation_id ?? null,
      branch: c.branch ?? null,
      cwd: null,
      workspace_id: null,
      tab_id: null,
      worker_pane: null,
      reviewer_pane: null,
      round: 0,
      worked: 0,
      attention: null,
      resume_lane: null,
      summary: c.summary ?? null,
      prs: null,
      quiet: 0,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
    this.data.cards.push(row);
    this.persist();
    return row;
  }

  /** Callers update rows they just read, so a missing id is a bug, not a case to handle. */
  private patch<T extends { id: number }>(rows: T[], id: number, patch: Partial<T>): T {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row #${id} to update`);
    for (const [k, v] of Object.entries(patch)) if (k !== "id" && v !== undefined) (row as any)[k] = v;
    this.persist();
    return { ...row };
  }

  private unique(name: string, path: string, self?: number): void {
    for (const p of this.data.projects) {
      if (p.id === self) continue;
      if (p.name === name) throw new Error(`a project named '${name}' already exists`);
      if (p.path === path) throw new Error(`${path} is already the project '${p.name}'`);
    }
  }

  private persist(): void {
    if (!this.batching && this.path !== ":memory:") writeJson(this.path, this.data);
  }
}

function copy<T extends object>(row: T | undefined): T | null {
  return row ? { ...row } : null;
}
