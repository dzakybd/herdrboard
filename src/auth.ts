// The board starts agents that may run with bypassed permissions, so anything
// that can call the API can run commands on this Mac. Requests from this
// machine pass (the CLI and agents); other devices, which reach it through
// `tailscale serve`, need the token: typed into the login page (set it with
// `hb password`) or carried by the `hb url` link. Either way it becomes a cookie.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COOKIE = "hb_token";
const cookieFor = (token: string) => `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
const LOGIN_PAGE = new URL("../web/login.html", import.meta.url).pathname;

export function loadToken(home: string): string {
  const path = `${home}/token`;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export function saveToken(home: string, token: string): void {
  if (token.length < 8) throw new Error("the password needs at least 8 characters");
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes(";")) throw new Error("the password may use printable ASCII without spaces or ';'");
  writeFileSync(`${home}/token`, token, { mode: 0o600 });
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** null = allowed; otherwise the response to send instead. */
export function gate(req: Request, ip: string, token: string, port: number): Response | null {
  // Browsers can't send a cross-site application/json body without a CORS
  // preflight, which this server never grants: that closes off CSRF.
  if (req.method !== "GET" && !req.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }
  // A local reverse proxy (`tailscale serve`) also connects from loopback: its
  // forwarding headers mark the request as coming from another device.
  const proxied = ["x-forwarded-for", "forwarded", "tailscale-user-login"].some((h) => req.headers.has(h));
  if (isLoopback(ip) && !proxied) {
    // A local request for some other Host is a DNS-rebinding page, not us.
    const host = req.headers.get("host") ?? "";
    if ([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return null;
  }
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && same(fromQuery, token)) {
    url.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: {
        location: url.pathname + url.search,
        "set-cookie": cookieFor(token),
      },
    });
  }
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const header = req.headers.get("x-hb-token");
  if ((cookie && same(cookie, token)) || (header && same(header, token))) return null;
  if (req.method === "GET" && req.headers.get("accept")?.includes("text/html")) {
    return new Response(Bun.file(LOGIN_PAGE), { status: 401, headers: { "content-type": "text/html" } });
  }
  return new Response("herdrboard: sign in at / with the password from `hb password`, or open the `hb url` link.", { status: 401 });
}

// A guessed password runs commands on this Mac: allow few failures per window.
const MAX_FAILURES = 10, WINDOW_MS = 10 * 60_000;
let failures: number[] = [];

/** POST /login {password}: sets the cookie when the password matches the token. */
export async function login(req: Request, token: string, now = Date.now()): Promise<Response> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  }
  failures = failures.filter((t) => now - t < WINDOW_MS);
  if (failures.length >= MAX_FAILURES) return Response.json({ error: "too many wrong passwords; try again in 10 minutes" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password === "string" && same(body.password, token)) {
    failures = [];
    return Response.json({ ok: true }, { headers: { "set-cookie": cookieFor(token) } });
  }
  failures.push(now);
  return Response.json({ error: "wrong password" }, { status: 401 });
}
