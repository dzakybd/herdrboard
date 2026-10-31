import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Card, Profile, Project, Role, Settings } from "./db.ts";

/** cc1(), cc2(), ccd() … launcher functions from ~/.zshrc; resume/continue variants are skipped. */
export function profilesFromZshrc(text: string): Profile[] {
  const names = [...text.matchAll(/^(cc\d+|ccd)\(\)/gm)].map((m) => m[1]!);
  return [...new Set(names)].map((name) => ({ name, command: name }));
}

export function defaultSettings(zshrc = `${homedir()}/.zshrc`): Settings {
  const found = existsSync(zshrc) ? profilesFromZshrc(readFileSync(zshrc, "utf8")) : [];
  const profiles = found.length ? found : [{ name: "claude", command: "claude" }];
  const first = profiles[0]!.name;
  return { profiles, roles: { orchestrator: first, worker: first, reviewer: first }, maxWorkers: 3, maxRounds: 2 };
}

/** Card override → project override → settings default. */
export function resolveProfile(s: Settings, role: Role, project: Project, card?: Card): Profile {
  const name = (role !== "orchestrator" && card?.[role]) || project[role] || s.roles[role];
  const profile = s.profiles.find((p) => p.name === name);
  if (!profile) throw new Error(`unknown profile '${name}' for ${role}`);
  return profile;
}
