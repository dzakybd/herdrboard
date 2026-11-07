// The board starts agents that may run with bypassed permissions, so anything
// that can call the API can run commands on this Mac. Requests from this
// machine pass (the CLI and agents); other devices, which reach it through
// `tailscale serve`, need the token that `hb url` hands out as a one-time link
// that sets a cookie.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COOKIE = "hb_token";

export function loadToken(home: string): string {
  const path = `${home}/token`;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
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
        "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
      },
    });
  }
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const header = req.headers.get("x-hb-token");
  if ((cookie && same(cookie, token)) || (header && same(header, token))) return null;
  return new Response("herdrboard: open the link printed by `hb url` on this device once.", { status: 401 });
}
