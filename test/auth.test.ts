import { describe, expect, test } from "bun:test";
import { gate, login, saveToken } from "../src/auth.ts";

const T = "secret-token";
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://x${path}`, { ...init, headers: { host: init.host ?? "127.0.0.1:7320", "content-type": "application/json", ...(init.headers as object) } });

describe("gate", () => {
  test("loopback with a local Host passes without a token", () => {
    expect(gate(req("/api/state"), "127.0.0.1", T, 7320)).toBeNull();
    expect(gate(req("/api/state", { host: "localhost:7320" }), "::1", T, 7320)).toBeNull();
  });
  test("loopback with a foreign Host (DNS rebinding) needs the token", () => {
    expect(gate(req("/api/state", { host: "evil.example:7320" }), "127.0.0.1", T, 7320)?.status).toBe(401);
    // tailscale serve keeps the Host it was asked for and adds forwarding headers.
    expect(gate(req("/api/state", { host: "mac.tail1.ts.net:8443", headers: { "x-forwarded-for": "100.64.1.2" } }), "127.0.0.1", T, 7320)?.status).toBe(401);
    expect(gate(req("/api/state", { headers: { "x-forwarded-for": "100.64.1.2" } }), "127.0.0.1", T, 7320)?.status).toBe(401);
    expect(gate(req("/api/state", { headers: { "tailscale-user-login": "me@example.com" } }), "127.0.0.1", T, 7320)?.status).toBe(401);
  });
  test("other devices are refused without the token", () => {
    expect(gate(req("/", { host: "mac.local:7320" }), "192.168.1.20", T, 7320)?.status).toBe(401);
    expect(gate(req("/", { host: "mac.local:7320", headers: { cookie: "hb_token=wrong" } }), "192.168.1.20", T, 7320)?.status).toBe(401);
  });
  test("a token link sets a cookie, redirects without the token, and the cookie then works", () => {
    const r = gate(req(`/?token=${T}`, { host: "mac.local:7320" }), "192.168.1.20", T, 7320)!;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(gate(req("/api/state", { host: "mac.local:7320", headers: { cookie: cookie.split(";")[0]! } }), "192.168.1.20", T, 7320)).toBeNull();
  });
  test("a wrong token in the link is refused", () => {
    expect(gate(req("/?token=nope", { host: "mac.local:7320" }), "192.168.1.20", T, 7320)?.status).toBe(401);
  });
  test("writes must be JSON, even from loopback", () => {
    const form = new Request("http://x/api/cards", { method: "POST", headers: { host: "127.0.0.1:7320", "content-type": "text/plain" }, body: "{}" });
    expect(gate(form, "127.0.0.1", T, 7320)?.status).toBe(415);
  });
  test("a browser without the cookie gets the login page", async () => {
    const r = gate(req("/", { host: "mac.local:7320", headers: { accept: "text/html" } }), "192.168.1.20", T, 7320)!;
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('type="password"');
  });
});

describe("login", () => {
  const post = (body: unknown, type = "application/json") =>
    new Request("http://x/login", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  test("the right password sets the cookie the gate accepts", async () => {
    const r = await login(post({ password: T }), T);
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    expect(gate(req("/api/state", { host: "mac.local:7320", headers: { cookie } }), "192.168.1.20", T, 7320)).toBeNull();
  });
  test("a wrong password sets nothing; a form post is refused", async () => {
    const r = await login(post({ password: "nope" }), T);
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await login(post({ password: T }, "application/x-www-form-urlencoded"), T)).status).toBe(415);
  });
  test("too many wrong passwords lock login, even the right one, until the window passes", async () => {
    const t0 = 1e15;
    for (let i = 0; i < 10; i++) await login(post({ password: "nope" }), T, t0);
    expect((await login(post({ password: T }), T, t0)).status).toBe(429);
    expect((await login(post({ password: T }), T, t0 + 10 * 60_000)).status).toBe(200);
  });
});

test("saveToken rejects short passwords and cookie-breaking characters", () => {
  expect(() => saveToken("/nonexistent", "short")).toThrow("at least 8");
  expect(() => saveToken("/nonexistent", "has space in it")).toThrow("printable ASCII");
  expect(() => saveToken("/nonexistent", "semi;colon!")).toThrow("printable ASCII");
});
