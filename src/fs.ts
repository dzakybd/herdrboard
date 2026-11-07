import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Listing {
  path: string; // absolute
  display: string; // ~-abbreviated
  parent: string | null;
  git: boolean; // this folder is a repository root
  dirs: { name: string; git: boolean }[];
}

/** Writes a synced temp file, then renames it over `path`: a crash leaves the old file or the new one, never half of either. */
export function writeJson(path: string, value: unknown, mode = 0o644): void {
  const fd = openSync(`${path}.tmp`, "w", mode);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${path}.tmp`, path);
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`can't read ${path}: ${(e as Error).message}. Fix or move the file, then start again.`);
  }
}

export const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const abbreviate = (p: string) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

/** Subfolders of `raw` (default: home), marking the ones that are git repository roots. */
export function listDirs(raw: string, hidden = false): Listing {
  const path = realpathSync(expandHome(raw || "~"));
  if (!statSync(path).isDirectory()) throw new Error(`not a folder: ${path}`);
  const dirs = readdirSync(path, { withFileTypes: true })
    .filter((d) => (hidden || !d.name.startsWith(".")) && (d.isDirectory() || (d.isSymbolicLink() && isDir(join(path, d.name)))))
    .map((d) => ({ name: d.name, git: existsSync(join(path, d.name, ".git")) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { path, display: abbreviate(path), parent: path === "/" ? null : dirname(path), git: existsSync(join(path, ".git")), dirs };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
