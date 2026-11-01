import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const PORT = 17000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(`${tmpdir()}/hb-srv-`);
let server: ReturnType<typeof Bun.spawn>;

const send = (method: string, path: string, body?: unknown) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const b64 = (t: string) => Buffer.from(t).toString("base64");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(async () => {
  server = Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "serve"], {
    env: { ...process.env, HB_HOME: home, HB_PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await send("GET", "/api/state");
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const repo = mkdtempSync(`${tmpdir()}/hb-repo-`);
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  const res = await send("POST", "/api/projects", { path: repo, name: "demo" });
  expect(res.status).toBe(200);
}, 20_000);

afterAll(() => server.kill("SIGTERM"));

describe("attachments over HTTP", () => {
  test("upload with a card, serve images inline and everything else as a download", async () => {
    const res = await send("POST", "/api/cards", {
      project: "demo",
      title: "with files",
      lane: "backlog",
      attachments: [{ name: "shot.png", data: PNG }, { name: "page.html", data: b64("<script>alert(1)</script>") }],
    });
    const card: any = await res.json();
    expect(res.status).toBe(200);

    const img = await send("GET", `/api/cards/${card.id}/attachments/shot.png`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toContain("inline");

    const html = await send("GET", `/api/cards/${card.id}/attachments/page.html`);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toContain("attachment");
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const shown: any = await (await send("GET", `/api/cards/${card.id}`)).json();
    expect(shown.attachments.map((a: any) => a.name)).toEqual(["page.html", "shot.png"]);
  });

  test("a name that is not an attachment is a 404, including path tricks", async () => {
    const card: any = await (await send("POST", "/api/cards", { project: "demo", title: "x", lane: "backlog", attachments: [{ name: "a.txt", data: b64("a") }] })).json();
    for (const name of ["..%2Fworker.md", "..%2F..%2Fherdrboard.db", "missing.txt"]) {
      expect((await send("GET", `/api/cards/${card.id}/attachments/${name}`)).status).toBe(404);
    }
  });

  test("a bad upload is refused and leaves no card behind", async () => {
    const before: any = await (await send("GET", "/api/state")).json();
    const res = await send("POST", "/api/cards", { project: "demo", title: "bad", lane: "backlog", attachments: [{ name: "x" }] });
    expect(res.status).toBe(400);
    const after: any = await (await send("GET", "/api/state")).json();
    expect(after.cards.length).toBe(before.cards.length);
  });

  test("a non-JSON upload is refused (CSRF guard)", async () => {
    const res = await fetch(`${BASE}/api/cards/1/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  test("deleting a card removes its files", async () => {
    const card: any = await (await send("POST", "/api/cards", { project: "demo", title: "gone", lane: "backlog", attachments: [{ name: "a.txt", data: b64("a") }] })).json();
    const dir = `${home}/cards/${card.id}`;
    expect(existsSync(dir)).toBe(true);
    expect((await send("DELETE", `/api/cards/${card.id}`)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });
});
