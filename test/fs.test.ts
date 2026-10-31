import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { listDirs } from "../src/fs.ts";

test("lists subfolders sorted, marks git roots, hides dotfolders unless asked", () => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/hb-fs-`));
  for (const d of ["beta", "Alpha/.git", ".hidden", "linked-target"]) mkdirSync(`${root}/${d}`, { recursive: true });
  writeFileSync(`${root}/file.txt`, "");
  symlinkSync(`${root}/linked-target`, `${root}/link`);

  const l = listDirs(root);
  expect(l.path).toBe(root);
  expect(l.dirs).toEqual([
    { name: "Alpha", git: true },
    { name: "beta", git: false },
    { name: "link", git: false },
    { name: "linked-target", git: false },
  ]);
  expect(listDirs(root, true).dirs.map((d) => d.name)).toContain(".hidden");
  expect(listDirs(`${root}/beta`).parent).toBe(root);
  expect(listDirs(`${root}/Alpha`).git).toBe(true);
  expect(listDirs(root).git).toBe(false);
});

test("expands ~ and abbreviates the display path", () => {
  const l = listDirs("~");
  expect(l.path).toBe(realpathSync(homedir()));
  expect(l.display.startsWith("~")).toBe(true);
});

test("rejects files and missing paths", () => {
  const root = mkdtempSync(`${tmpdir()}/hb-fs-`);
  writeFileSync(`${root}/f`, "");
  expect(() => listDirs(`${root}/f`)).toThrow("not a folder");
  expect(() => listDirs(`${root}/nope`)).toThrow();
});
