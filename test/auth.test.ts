import { describe, expect, test } from "bun:test";
import { gate } from "../src/auth.ts";

const T = "secret-token";
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://x${path}`, { ...init, headers: { host: init.host ?? "127.0.0.1:7420", "content-type": "application/json", ...(init.headers as object) } });

describe("gate", () => {
  test("loopback with a local Host passes without a token", () => {
    expect(gate(req("/api/state"), "127.0.0.1", T, 7420)).toBeNull();
    expect(gate(req("/api/state", { host: "localhost:7420" }), "::1", T, 7420)).toBeNull();
  });
  test("loopback with a foreign Host (DNS rebinding) needs the token", () => {
    expect(gate(req("/api/state", { host: "evil.example:7420" }), "127.0.0.1", T, 7420)?.status).toBe(401);
  });
  test("other devices are refused without the token", () => {
    expect(gate(req("/", { host: "mac.local:7420" }), "192.168.1.20", T, 7420)?.status).toBe(401);
    expect(gate(req("/", { host: "mac.local:7420", headers: { cookie: "hb_token=wrong" } }), "192.168.1.20", T, 7420)?.status).toBe(401);
  });
  test("a token link sets a cookie, redirects without the token, and the cookie then works", () => {
    const r = gate(req(`/?token=${T}`, { host: "mac.local:7420" }), "192.168.1.20", T, 7420)!;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(gate(req("/api/state", { host: "mac.local:7420", headers: { cookie: cookie.split(";")[0]! } }), "192.168.1.20", T, 7420)).toBeNull();
  });
  test("a wrong token in the link is refused", () => {
    expect(gate(req("/?token=nope", { host: "mac.local:7420" }), "192.168.1.20", T, 7420)?.status).toBe(401);
  });
  test("writes must be JSON, even from loopback", () => {
    const form = new Request("http://x/api/cards", { method: "POST", headers: { host: "127.0.0.1:7420", "content-type": "text/plain" }, body: "{}" });
    expect(gate(form, "127.0.0.1", T, 7420)?.status).toBe(415);
  });
});
