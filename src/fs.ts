import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Listing {
  path: string; // absolute
  display: string; // ~-abbreviated
  parent: string | null;
  git: boolean; // this folder is a repository root
  dirs: { name: string; git: boolean }[];
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
