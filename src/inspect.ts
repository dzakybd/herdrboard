import { existsSync, realpathSync } from "node:fs";
import { expandHome } from "./fs.ts";
import type { Inspect } from "./transfer.ts";

export function git(path: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", path, ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** Can this path be a project here? Keeps the export's base branch when the repository has it. */
export const inspectPath: Inspect = (raw, base) => {
  const path = expandHome(raw);
  if (!existsSync(path)) return { path, base, problem: `no such folder: ${path}` };
  const real = realpathSync(path);
  const top = git(real, "rev-parse", "--show-toplevel");
  if (top && top !== real) return { path: real, base, problem: `use the repository root: ${top}` };
  if (!top) return base ? { path: real, base, problem: `${real} is not a git repository, but the project uses base ${base}` } : { path: real, base };
  if (!base) return { path: real, base, note: "this is a git repository here, but it stays a folder project" };
  if (git(real, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)) return { path: real, base };
  const current = git(real, "symbolic-ref", "--short", "HEAD");
  if (!current || !git(real, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")) return { path: real, base, problem: `branch ${base} not found` };
  return { path: real, base: current, note: `branch ${base} not found, using ${current}` };
};
