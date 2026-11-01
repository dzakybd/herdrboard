import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPath } from "../src/inspect.ts";

let root: string;
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const repo = (name: string, commit = true) => {
  const dir = join(root, name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  if (commit) {
    writeFileSync(join(dir, "f"), "x");
    sh(dir, "add", "f");
    sh(dir, "commit", "-q", "-m", "init");
  }
  return dir;
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hb-inspect-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("inspectPath", () => {
  test("missing folder is a problem", () => {
    const missing = join(root, "nope");
    const r = inspectPath(missing, "");
    expect(r.problem).toBe(`no such folder: ${missing}`);
  });

  test("plain folder with empty base is fine", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    expect(inspectPath(dir, "")).toEqual({ path: dir, base: "" });
  });

  test("plain folder with a base is a problem", () => {
    const dir = join(root, "plain");
    expect(inspectPath(dir, "main").problem).toContain("is not a git repository");
  });

  test("repo root with its base branch", () => {
    const dir = repo("ok");
    expect(inspectPath(dir, "main")).toEqual({ path: dir, base: "main" });
  });

  test("subfolder of a repo says to use the root", () => {
    const dir = repo("sub");
    mkdirSync(join(dir, "pkg"));
    const r = inspectPath(join(dir, "pkg"), "main");
    expect(r.problem).toBe(`use the repository root: ${dir}`);
  });

  test("missing base falls back to the current branch with a note", () => {
    const dir = repo("fallback");
    const r = inspectPath(dir, "develop");
    expect(r.problem).toBeUndefined();
    expect(r.base).toBe("main");
    expect(r.note).toBe("branch develop not found, using main");
  });

  test("repo with no commits is a problem, never a fallback", () => {
    const dir = repo("empty", false);
    const r = inspectPath(dir, "develop");
    expect(r.problem).toBe("branch develop not found");
    expect(r.note).toBeUndefined();
    expect(inspectPath(dir, "main").problem).toBe("branch main not found");
  });

  test("empty base on a repo is a note", () => {
    const dir = repo("nobase");
    const r = inspectPath(dir, "");
    expect(r.problem).toBeUndefined();
    expect(r.note).toContain("stays a folder project");
  });

  test("symlink resolves to the real path", () => {
    const dir = repo("real");
    const link = join(root, "link");
    symlinkSync(dir, link);
    expect(inspectPath(link, "main")).toEqual({ path: dir, base: "main" });
  });
});
