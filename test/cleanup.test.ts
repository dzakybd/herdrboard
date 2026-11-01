import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { finishCleanup } from "../src/cleanup.ts";
import type { Card, Project } from "../src/db.ts";
import { git } from "../src/inspect.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/hb-clean-`);
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const G = ["-c", "user.name=t", "-c", "user.email=t@t"];
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...G, "-C", cwd, ...a]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
function repo(at: string) {
  mkdirSync(at, { recursive: true });
  sh(at, "init", "-q", "-b", "main");
  writeFileSync(`${at}/a.txt`, "a");
  sh(at, "add", ".");
  sh(at, "commit", "-q", "-m", "init");
}
const project = (path: string, base: string): Project => ({ id: 1, name: "p", path, base, review: 1, orchestrator: null, worker: null, reviewer: null, orch_pane: null });
const card = (over: Partial<Card>): Card => ({ id: 7, project_id: 1, automation_id: null, branch: null, ...over }) as Card;
const branches = (r: string) => git(r, "branch", "--format=%(refname:short)")!.split("\n");

describe("empty automation branches", () => {
  test("deleted when it has no commit beyond the base", async () => {
    const r = tmp();
    repo(r);
    sh(r, "branch", "hb/7-x");
    const notes = await finishCleanup(card({ automation_id: 1, branch: "hb/7-x" }), project(r, "main"));
    expect(branches(r)).toEqual(["main"]);
    expect(notes.join()).toContain("hb/7-x");
  });

  test("kept when it has a commit", async () => {
    const r = tmp();
    repo(r);
    sh(r, "switch", "-q", "-c", "hb/7-x");
    writeFileSync(`${r}/b.txt`, "b");
    sh(r, "add", ".");
    sh(r, "commit", "-q", "-m", "work");
    sh(r, "switch", "-q", "main");
    await finishCleanup(card({ automation_id: 1, branch: "hb/7-x" }), project(r, "main"));
    expect(branches(r)).toContain("hb/7-x");
  });

  test("kept for a card made by hand", async () => {
    const r = tmp();
    repo(r);
    sh(r, "branch", "hb/7-x");
    await finishCleanup(card({ branch: "hb/7-x" }), project(r, "main"));
    expect(branches(r)).toContain("hb/7-x");
  });

  test("a branch outside hb/ is never touched", async () => {
    const r = tmp();
    repo(r);
    sh(r, "branch", "feature");
    await finishCleanup(card({ automation_id: 1, branch: "feature" }), project(r, "main"));
    expect(branches(r)).toContain("feature");
  });
});

describe("folder worktrees", () => {
  function folder() {
    const f = tmp();
    const r = `${f}/app`;
    repo(r);
    mkdirSync(`${f}/.hb-worktrees/7`, { recursive: true });
    sh(r, "worktree", "add", "-q", `${f}/.hb-worktrees/7/app`, "-b", "hb/7-x");
    return { f, r, wt: `${f}/.hb-worktrees/7/app` };
  }

  test("clean worktree is removed, branch and repo stay", async () => {
    const { f, r, wt } = folder();
    await finishCleanup(card({}), project(f, ""));
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(`${f}/.hb-worktrees`)).toBe(false);
    expect(branches(r)).toContain("hb/7-x");
    expect(existsSync(`${r}/a.txt`)).toBe(true);
    expect(git(r, "status", "--porcelain")).toBe("");
  });

  test("dirty worktree is kept and reported", async () => {
    const { f, wt } = folder();
    writeFileSync(`${wt}/new.txt`, "unsaved");
    const notes = await finishCleanup(card({}), project(f, ""));
    expect(existsSync(`${wt}/new.txt`)).toBe(true);
    expect(notes.join()).toContain(wt);
  });

  test("a symlink in the card folder is left alone and its target unharmed", async () => {
    const f = tmp();
    const target = tmp();
    writeFileSync(`${target}/keep.txt`, "k");
    mkdirSync(`${f}/.hb-worktrees/7`, { recursive: true });
    symlinkSync(target, `${f}/.hb-worktrees/7/link`);
    const notes = await finishCleanup(card({}), project(f, ""));
    expect(existsSync(`${target}/keep.txt`)).toBe(true);
    expect(existsSync(`${f}/.hb-worktrees/7/link`)).toBe(true);
    expect(notes.join()).toContain("link");
  });

  test("a plain directory inside another repo is not mistaken for a worktree", async () => {
    const f = tmp();
    repo(f);
    mkdirSync(`${f}/.hb-worktrees/7/plain`, { recursive: true });
    writeFileSync(`${f}/.hb-worktrees/7/plain/x.txt`, "x");
    await finishCleanup(card({}), project(f, ""));
    expect(existsSync(`${f}/.hb-worktrees/7/plain/x.txt`)).toBe(true);
  });

  test("missing folder is a no-op, and two runs are harmless", async () => {
    expect(await finishCleanup(card({}), project(tmp(), ""))).toEqual([]);
    const { f, r } = folder();
    await finishCleanup(card({}), project(f, ""));
    expect(await finishCleanup(card({}), project(f, ""))).toEqual([]);
    expect(branches(r)).toContain("hb/7-x");
  });
});
