// Moves a board between machines as one JSON file. Import is two steps: planImport
// checks the file against this machine and changes nothing, applyImport writes it
// in one transaction. Importing twice adds nothing new.

import type { Automation, Card, CardEvent, Project, Settings, Store } from "./db.ts";
import { parseRole, storeRole, validateSettings } from "./profiles.ts";
import { parseTrigger } from "./scheduler.ts";

const BUNDLE_VERSION = 1;
const PORTABLE_LANES = ["backlog", "todo", "done"];

type BundleProject = Pick<Project, "name" | "path" | "base" | "review" | "orchestrator" | "worker" | "reviewer">;
type BundleAutomation = Pick<Automation, "name" | "trigger" | "title" | "brief" | "worktree" | "review" | "worker" | "reviewer" | "enabled"> & { project: string };
type BundleCard = Pick<Card, "title" | "brief" | "lane" | "review" | "worktree" | "worker" | "reviewer" | "branch" | "summary" | "created_at" | "updated_at"> & {
  project: string;
  automation: string | null;
  events: Pick<CardEvent, "at" | "text">[];
};

export interface Bundle {
  version: number;
  exported_at: number;
  in_progress_left_out: number;
  settings: Settings;
  projects: BundleProject[];
  automations: BundleAutomation[];
  cards: BundleCard[];
}

export interface ImportChoices {
  paths?: Record<string, string>; // project name → path on this machine
  skip?: string[]; // project names to leave out, with their automations and cards
}

/** What a path turned out to be here: `problem` blocks the import, `note` does not. */
export type Inspect = (path: string, base: string) => { path: string; base: string; note?: string; problem?: string };

export interface ProjectPlan {
  name: string;
  path: string;
  base: string;
  action: "add" | "exists" | "skip";
  note?: string;
  problem?: string;
}

interface Tally {
  add: number;
  existing: number;
  skipped: number;
}

export interface ImportPlan {
  ok: boolean;
  projects: ProjectPlan[];
  automations: Tally;
  cards: Tally;
  in_progress_left_out: number;
  errors: string[];
  warnings: string[];
  settings: Settings;
}

export function exportBundle(store: Store): Bundle {
  const projects = store.projects();
  const automations = store.automations();
  const projectName = (id: number) => projects.find((p) => p.id === id)!.name;
  const portable = store.cards().filter((c) => PORTABLE_LANES.includes(c.lane));
  return {
    version: BUNDLE_VERSION,
    exported_at: Date.now(),
    in_progress_left_out: store.cards().length - portable.length,
    settings: store.settings(),
    projects: projects.map(({ name, path, base, review, orchestrator, worker, reviewer }) => ({ name, path, base, review, orchestrator, worker, reviewer })),
    automations: automations.map(({ name, project_id, trigger, title, brief, worktree, review, worker, reviewer, enabled }) => ({
      name, project: projectName(project_id), trigger, title, brief, worktree, review, worker, reviewer, enabled,
    })),
    cards: portable.map((c) => ({
      project: projectName(c.project_id),
      automation: automations.find((a) => a.id === c.automation_id)?.name ?? null,
      title: c.title, brief: c.brief, lane: c.lane, review: c.review, worktree: c.worktree, worker: c.worker, reviewer: c.reviewer,
      branch: c.branch, summary: c.summary, created_at: c.created_at, updated_at: c.updated_at,
      events: store.events(c.id).map(({ at, text }) => ({ at, text })),
    })),
  };
}

function parseBundle(input: unknown): Bundle {
  const b = input as Bundle | null;
  if (!b || typeof b !== "object" || b.version === undefined) throw new Error("this is not a herdrboard export");
  if (b.version !== BUNDLE_VERSION) throw new Error(`unsupported export version ${b.version}`);
  if (!b.settings || ![b.projects, b.automations, b.cards].every(Array.isArray)) throw new Error("the export is incomplete");
  const text = (v: unknown) => typeof v === "string";
  if (!b.projects.every((p) => text(p?.name) && text(p?.path) && text(p?.base))) throw new Error("the export has a malformed project");
  if (!b.automations.every((a) => text(a?.name) && text(a?.project) && text(a?.trigger) && text(a?.title) && text(a?.brief))) throw new Error("the export has a malformed automation");
  const when = (v: unknown) => Number.isFinite(v);
  if (!b.cards.every((c) => text(c?.project) && text(c?.title) && text(c?.brief) && when(c?.created_at) && when(c?.updated_at) && Array.isArray(c?.events))) {
    throw new Error("the export has a malformed card");
  }
  return b;
}

const cardKey = (projectId: number, title: string, createdAt: number) => `${projectId}\0${title}\0${createdAt}`;

/** Checks `input` against this machine. Throws only if the file itself is unusable. */
export function planImport(store: Store, input: unknown, choices: ImportChoices, inspect: Inspect): ImportPlan {
  const bundle = parseBundle(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  const skip = new Set(choices.skip ?? []);
  const fresh = !store.projects().length;
  const local = store.settings();

  let settings = local;
  try {
    const incoming = validateSettings(bundle.settings);
    settings = fresh ? incoming : { ...local, profiles: [...local.profiles, ...incoming.profiles.filter((p) => !local.profiles.some((l) => l.name === p.name))] };
  } catch (e) {
    errors.push(`settings: ${(e as Error).message}`);
  }
  for (const p of settings.profiles) {
    if (!local.profiles.some((l) => l.command === p.command)) warnings.push(`profile ${p.name} runs \`${p.command}\` in a shell: check that it exists here and that you trust it`);
  }

  const checkRole = (owner: string, value: string | null) => {
    try {
      storeRole(parseRole(value), settings.profiles);
    } catch (e) {
      errors.push(`${owner}: ${(e as Error).message}`);
    }
  };

  const seen = new Set<string>();
  const projects = bundle.projects.map((p): ProjectPlan => {
    if (seen.has(p.name)) errors.push(`project ${p.name} appears twice`);
    seen.add(p.name);
    const chosen = choices.paths?.[p.name] ?? p.path;
    if (skip.has(p.name)) return { name: p.name, path: chosen, base: p.base, action: "skip" };
    const existing = store.projectByName(p.name);
    if (existing) return { name: p.name, path: existing.path, base: existing.base, action: "exists" };
    for (const role of [p.orchestrator, p.worker, p.reviewer]) checkRole(`project ${p.name}`, role);
    const found = inspect(chosen, p.base);
    return { name: p.name, path: found.path, base: found.base, action: "add", note: found.note, problem: found.problem };
  });
  for (const p of projects) {
    if (p.action !== "add" || p.problem) continue;
    const owner = store.projects().find((l) => l.path === p.path)?.name ?? projects.find((o) => o !== p && o.action === "add" && o.path === p.path)?.name;
    if (owner) p.problem = `already used by project ${owner}`;
  }

  const planFor = (name: string) => projects.find((p) => p.name === name);
  const automations: Tally = { add: 0, existing: 0, skipped: 0 };
  for (const a of bundle.automations) {
    const project = planFor(a.project);
    if (!project) {
      errors.push(`automation ${a.name}: unknown project '${a.project}'`);
    } else if (project.action === "skip") {
      automations.skipped++;
    } else if (store.automationByName(a.name)) {
      automations.existing++;
    } else {
      automations.add++;
      try {
        parseTrigger(a.trigger);
      } catch (e) {
        errors.push(`automation ${a.name}: ${(e as Error).message}`);
      }
      if (!a.title.trim()) errors.push(`automation ${a.name}: title is required`);
      checkRole(`automation ${a.name}`, a.worker);
      checkRole(`automation ${a.name}`, a.reviewer);
    }
  }

  const known = new Set(store.cards().map((c) => cardKey(c.project_id, c.title, c.created_at)));
  const cards: Tally = { add: 0, existing: 0, skipped: 0 };
  for (const c of bundle.cards) {
    const project = planFor(c.project);
    const localId = store.projectByName(c.project)?.id;
    if (!project) errors.push(`card ${c.title}: unknown project '${c.project}'`);
    else if (project.action === "skip") cards.skipped++;
    else if (localId && known.has(cardKey(localId, c.title, c.created_at))) cards.existing++;
    else cards.add++;
  }

  if (bundle.in_progress_left_out) warnings.push(`${bundle.in_progress_left_out} in-progress card(s) were left out of this export`);
  for (const p of projects) if (p.problem) errors.push(`project ${p.name}: ${p.problem}`);
  return { ok: !errors.length, projects, automations, cards, in_progress_left_out: bundle.in_progress_left_out, errors, warnings, settings };
}

/** Writes a plan from planImport, all of it or none of it. */
export function applyImport(store: Store, input: unknown, plan: ImportPlan): void {
  if (!plan.ok) throw new Error(`import blocked: ${plan.errors.join("; ")}`);
  const bundle = parseBundle(input);
  const write = store.db.transaction(() => {
    store.saveSettings(plan.settings);
    const roles = (v: string | null) => storeRole(parseRole(v), plan.settings.profiles);

    const projectIds = new Map<string, number>();
    for (const p of plan.projects) {
      if (p.action === "skip") continue;
      if (p.action === "exists") {
        projectIds.set(p.name, store.projectByName(p.name)!.id);
        continue;
      }
      const src = bundle.projects.find((s) => s.name === p.name)!;
      const row = store.addProject({ name: p.name, path: p.path, base: p.base, review: src.review });
      store.updateProject(row.id, { orchestrator: roles(src.orchestrator), worker: roles(src.worker), reviewer: roles(src.reviewer) });
      projectIds.set(p.name, row.id);
    }

    const automationIds = new Map<string, number>();
    for (const a of bundle.automations) {
      const project_id = projectIds.get(a.project);
      if (!project_id) continue;
      const row = store.automationByName(a.name)
        ?? store.addAutomation({ name: a.name, project_id, trigger: a.trigger, title: a.title.trim(), brief: a.brief, worktree: a.worktree, review: a.review, worker: roles(a.worker), reviewer: roles(a.reviewer), enabled: a.enabled });
      automationIds.set(a.name, row.id);
    }

    const known = new Set(store.cards().map((c) => cardKey(c.project_id, c.title, c.created_at)));
    for (const c of bundle.cards) {
      const project_id = projectIds.get(c.project);
      if (!project_id || known.has(cardKey(project_id, c.title, c.created_at))) continue;
      store.importCard({
        ...c,
        project_id,
        lane: c.lane === "done" ? "done" : "backlog", // never start agents as a side effect of importing
        worker: roles(c.worker),
        reviewer: roles(c.reviewer),
        automation_id: c.automation ? (automationIds.get(c.automation) ?? null) : null,
      });
    }
  });
  write();
}
