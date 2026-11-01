import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { git } from "./inspect.ts";
import type { Card, Project } from "./db.ts";

/** Runs after Finish. Returns card log lines; never throws. */
export type Cleanup = (card: Card, project: Project) => Promise<string[]>;

export const finishCleanup: Cleanup = async (card, project) => {
  const notes: string[] = [];
  try {
    if (project.base) {
      if (card.automation_id != null && card.branch) dropEmptyBranch(project, card.branch, notes);
    } else {
      dropFolderWorktrees(project, card.id, notes);
    }
  } catch (e) {
    notes.push(`cleanup failed: ${(e as Error).message}`);
  }
  return notes;
};

/** Local branch only, and only when it holds no commit the base lacks. */
function dropEmptyBranch(project: Project, branch: string, notes: string[]): void {
  if (!branch.startsWith("hb/")) return;
  const ref = `refs/heads/${branch}`;
  if (!git(project.path, "rev-parse", "--verify", "--quiet", ref)) return;
  const base = `refs/heads/${project.base}`;
  if (ref === base || !git(project.path, "rev-parse", "--verify", "--quiet", base)) return;
  if (git(project.path, "rev-list", "--count", `${base}..${ref}`) !== "0") return;
  if (git(project.path, "branch", "-D", branch) === null) notes.push(`could not delete empty branch ${branch}`);
  else notes.push(`deleted empty branch ${branch}`);
}

/** Removes clean worktrees under <folder>/.hb-worktrees/<id>/; branches stay since they may hold the work. */
function dropFolderWorktrees(project: Project, cardId: number, notes: string[]): void {
  const root = `${project.path}/.hb-worktrees`;
  const dir = `${root}/${cardId}`;
  if (!isRealDir(root) || !isRealDir(dir)) return;

  for (const name of readdirSync(dir)) {
    const wt = `${dir}/${name}`;
    if (!isRealDir(wt)) {
      notes.push(`left ${wt} in place: not a plain directory`);
      continue;
    }
    const why = removeWorktree(wt);
    if (why) notes.push(`kept worktree ${wt}: ${why}`);
    else notes.push(`removed worktree ${wt}`);
  }

  for (const d of [dir, root]) {
    try {
      if (readdirSync(d).length === 0) rmdirSync(d);
    } catch {}
  }
}

/** null when removed, otherwise the reason it was kept. */
function removeWorktree(wt: string): string | null {
  const top = git(wt, "rev-parse", "--show-toplevel");
  // A directory that is not itself a worktree would report the enclosing repository's status.
  if (!top || top !== realpathSync(wt) || !existsSync(`${wt}/.git`)) return "not a git worktree";
  const common = git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return "main repository not found";
  const status = git(wt, "status", "--porcelain");
  if (status === null) return "git status failed";
  if (status !== "") return "uncommitted changes";
  const r = Bun.spawnSync(["git", `--git-dir=${common}`, "worktree", "remove", wt]);
  return r.exitCode === 0 ? null : r.stderr.toString().trim() || "git worktree remove failed";
}

function isRealDir(p: string): boolean {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}
