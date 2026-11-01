import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { attachmentPath, listAttachments, removeAttachments, safeName, saveAttachments } from "../src/attachments.ts";

const home = () => mkdtempSync(`${tmpdir()}/hb-att-`);
const up = (name: string, text = "x") => ({ name, data: Buffer.from(text).toString("base64") });

describe("attachments", () => {
  test("safeName strips folders, spaces and leading dots", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\temp\\a b.png")).toBe("a_b.png");
    expect(safeName(".env")).toBe("env");
    expect(safeName("   ")).toBe("file");
  });

  test("saves, lists and never overwrites", () => {
    const h = home();
    const [a, b] = saveAttachments(h, 7, [up("shot.png", "one"), up("shot.png", "two")]);
    expect(readFileSync(a!, "utf8")).toBe("one");
    expect(readFileSync(b!, "utf8")).toBe("two");
    expect(listAttachments(h, 7).map((f) => f.name)).toEqual(["shot-2.png", "shot.png"]);
  });

  test("attachmentPath only returns listed files", () => {
    const h = home();
    saveAttachments(h, 1, [up("a.txt")]);
    expect(attachmentPath(h, 1, "a.txt")).toContain("/cards/1/attachments/a.txt");
    expect(attachmentPath(h, 1, "../worker.md")).toBeNull();
    expect(attachmentPath(h, 2, "a.txt")).toBeNull();
  });

  test("rejects bad input before writing anything", () => {
    const h = home();
    expect(() => saveAttachments(h, 1, [up("ok.txt"), { name: "bad" }])).toThrow("name and base64 data");
    expect(listAttachments(h, 1)).toEqual([]);
    expect(() => saveAttachments(h, 1, "nope")).toThrow("list of");
    expect(saveAttachments(h, 1, undefined)).toEqual([]);
  });

  test("removeAttachments clears the card folder", () => {
    const h = home();
    saveAttachments(h, 3, [up("a.txt")]);
    removeAttachments(h, 3);
    expect(listAttachments(h, 3)).toEqual([]);
  });
});
