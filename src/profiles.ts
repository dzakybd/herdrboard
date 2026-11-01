import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Card, Profile, Project, Role, RoleConfig, Settings } from "./db.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODES = ["bypassPermissions", "acceptEdits", "auto", "manual", "dontAsk", "plan"] as const;
// Typed into a shell, so only characters model ids actually use.
const MODEL_RE = /^[A-Za-z0-9._:\/\[\]-]{1,80}$/;

/** cc1(), cc2(), ccd() … launcher functions from ~/.zshrc; resume/continue variants are skipped. */
export function profilesFromZshrc(text: string): Profile[] {
  const names = [...text.matchAll(/^(cc\d+|ccd)\(\)/gm)].map((m) => m[1]!);
  return [...new Set(names)].map((name) => ({ name, command: name }));
}

export function defaultSettings(zshrc = `${homedir()}/.zshrc`): Settings {
  const found = existsSync(zshrc) ? profilesFromZshrc(readFileSync(zshrc, "utf8")) : [];
  const profiles = found.length ? found : [{ name: "claude", command: "claude" }];
  const role = () => ({ profile: profiles[0]!.name, mode: "bypassPermissions" });
  return { profiles, roles: { orchestrator: role(), worker: role(), reviewer: role() }, maxWorkers: 3, maxRounds: 2 };
}

/** Override columns hold a RoleConfig as JSON; older rows hold a bare profile name. */
export function parseRole(text: string | null | undefined): RoleConfig {
  if (!text) return {};
  if (!text.startsWith("{")) return { profile: text };
  return JSON.parse(text);
}

function compact(cfg: RoleConfig): RoleConfig {
  return Object.fromEntries(Object.entries(cfg).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as RoleConfig;
}

/** Throws on anything unsafe or unknown; returns the config without empty fields. */
export function validateRole(cfg: RoleConfig, profiles: Profile[]): RoleConfig {
  const c = compact(cfg);
  if (c.profile && !profiles.some((p) => p.name === c.profile)) throw new Error(`unknown profile '${c.profile}'`);
  if (c.model && !MODEL_RE.test(c.model)) throw new Error(`invalid model '${c.model}'`);
  if (c.effort && !(EFFORTS as readonly string[]).includes(c.effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  if (c.mode && !(MODES as readonly string[]).includes(c.mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  return c;
}

/** API input (profile name, config object, or empty) → stored override column value. */
export function storeRole(input: unknown, profiles: Profile[]): string | null {
  if (input === null || input === undefined || input === "") return null;
  const cfg = validateRole(typeof input === "string" ? { profile: input } : (input as RoleConfig), profiles);
  return Object.keys(cfg).length ? JSON.stringify(cfg) : null;
}

export function validateSettings(s: Settings): Settings {
  if (!Array.isArray(s.profiles) || !s.profiles.length) throw new Error("at least one profile is required");
  for (const p of s.profiles) if (!p.name?.trim() || !p.command?.trim()) throw new Error("each profile needs a name and a command");
  const roles = {} as Settings["roles"];
  for (const role of ["orchestrator", "worker", "reviewer"] as const) {
    const cfg = validateRole(s.roles?.[role] ?? {}, s.profiles);
    if (!cfg.profile) throw new Error(`${role} needs a profile`);
    roles[role] = cfg as Settings["roles"][typeof role];
  }
  if (!(s.maxWorkers >= 1) || !(s.maxRounds >= 0)) throw new Error("maxWorkers must be ≥ 1 and maxRounds ≥ 0");
  return { profiles: s.profiles, roles, maxWorkers: Number(s.maxWorkers), maxRounds: Number(s.maxRounds) };
}

export interface ResolvedRole {
  profile: Profile;
  model?: string;
  effort?: string;
  mode?: string;
}

/** Field by field: card override → project override → settings default. */
export function resolveRole(s: Settings, role: Role, project: Project, card?: Card): ResolvedRole {
  const cardCfg = card && role !== "orchestrator" ? compact(parseRole(card[role])) : {};
  const merged = { ...compact(s.roles[role]), ...compact(parseRole(project[role])), ...cardCfg };
  const profile = s.profiles.find((p) => p.name === merged.profile);
  if (!profile) throw new Error(`unknown profile '${merged.profile}' for ${role}`);
  return { profile, model: merged.model, effort: merged.effort, mode: merged.mode };
}

export function launchCommand(r: ResolvedRole): string {
  return [
    r.profile.command,
    r.model && `--model ${r.model}`,
    r.effort && `--effort ${r.effort}`,
    r.mode && `--permission-mode ${r.mode}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function describeRole(r: ResolvedRole): string {
  return [r.profile.name, r.model, r.effort, r.mode].filter(Boolean).join(" · ");
}
