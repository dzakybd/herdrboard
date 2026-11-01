import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { LANES, Store, type Lane } from "./db.ts";
import { gate, loadToken } from "./auth.ts";
import { expandHome, listDirs } from "./fs.ts";
import { cliHerdr } from "./herdr.ts";
import { Pipeline, slug } from "./pipeline.ts";
import { defaultSettings, EFFORTS, MODES, storeRole, validateSettings } from "./profiles.ts";
import { nextDue, parseTrigger } from "./scheduler.ts";
import { applyImport, exportBundle, planImport, type Inspect } from "./transfer.ts";

export const HOME = process.env.HB_HOME ?? `${homedir()}/.herdrboard`;
export const PORT = Number(process.env.HB_PORT ?? 7420);
const HOST = process.env.HB_HOST ?? "0.0.0.0";
const TICK_MS = 3000;

const PROJECT_FIELDS = ["name", "base", "review", "orchestrator", "worker", "reviewer"];
const CARD_FIELDS = ["title", "brief", "review", "worktree", "worker", "reviewer"];
const AUTOMATION_FIELDS = ["project_id", "trigger", "title", "brief", "worktree", "review", "worker", "reviewer", "enabled"];

function pick(body: Record<string, unknown>, fields: string[]): Record<string, any> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => fields.includes(k)));
}

function git(path: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", path, ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** Can this path be a project here? Keeps the export's base branch when the repository has it. */
const inspectPath: Inspect = (raw, base) => {
  const path = expandHome(raw);
  if (!existsSync(path)) return { path, base, problem: `no such folder: ${path}` };
  const real = realpathSync(path);
  const top = git(real, "rev-parse", "--show-toplevel");
  if (top && top !== real) return { path: real, base, problem: `use the repository root: ${top}` };
  if (!top) return base ? { path: real, base, problem: `${real} is not a git repository, but the project uses base ${base}` } : { path: real, base };
  if (!base) return { path: real, base, note: "this is a git repository here, but it stays a folder project" };
  if (git(real, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)) return { path: real, base };
  const current = git(real, "symbolic-ref", "--short", "HEAD");
  if (!current || !git(real, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")) return { path: real, base, problem: `branch ${base} not found` };
  return { path: real, base: current, note: `branch ${base} not found, using ${current}` };
};

const ROLE_FIELDS = ["orchestrator", "worker", "reviewer"];

export function serve(): void {
  mkdirSync(HOME, { recursive: true });
  const store = new Store(`${HOME}/herdrboard.db`, () => defaultSettings());
  const pipe = new Pipeline(store, cliHerdr, { home: HOME, url: `http://127.0.0.1:${PORT}` });

  /** Role override fields (name, config object or empty) → validated JSON column values. */
  const roles = <T extends Record<string, any>>(patch: T): T => {
    const profiles = store.settings().profiles;
    const out: Record<string, any> = { ...patch };
    for (const f of ROLE_FIELDS) if (f in out) out[f] = storeRole(out[f], profiles);
    return out as T;
  };

  const card = (id: string) => {
    const c = store.card(Number(id));
    if (!c) throw new Error(`no card #${id}`);
    return c;
  };

  const api: Record<string, (req: Request, p: Record<string, string>, body: any) => unknown> = {
    "GET /api/state": () => {
      const now = Date.now();
      const status = (pane: string | null) => (pane && pipe.statuses.get(pane)) || null;
      return {
        lanes: LANES,
        efforts: EFFORTS,
        modes: MODES,
        settings: store.settings(),
        projects: store.projects().map((p) => ({ ...p, orch_status: status(p.orch_pane) })),
        cards: store.cards().map((c) => ({ ...c, agent_status: status(pipe.activePane(c)) })),
        automations: store.automations().map((a) => ({
          ...a,
          next_due: nextDue(parseTrigger(a.trigger), Math.max(a.last_run_at, a.created_at), now),
        })),
      };
    },
    "GET /api/fs": (req) => {
      const q = new URL(req.url).searchParams;
      const fallback = store.projects()[0]?.path.replace(/\/[^/]+$/, "") || "~";
      return listDirs(q.get("path") || fallback, q.get("hidden") === "1");
    },
    "PUT /api/settings": (_r, _p, body) => {
      store.saveSettings(validateSettings(body));
      return store.settings();
    },

    "GET /api/export": () => exportBundle(store),
    "POST /api/import/check": (_r, _p, body) => planImport(store, body.bundle, body, inspectPath),
    "POST /api/import": (_r, _p, body) => {
      const plan = planImport(store, body.bundle, body, inspectPath);
      applyImport(store, body.bundle, plan);
      return plan;
    },

    "POST /api/projects": (_r, _p, body) => {
      const raw = expandHome(String(body.path ?? ""));
      if (!existsSync(raw)) throw new Error(`no such folder: ${raw}`);
      const path = realpathSync(raw);
      const top = git(path, "rev-parse", "--show-toplevel");
      if (top && top !== path) throw new Error(`use the repository root: ${top}`);
      const base = top ? body.base || git(path, "symbolic-ref", "--short", "HEAD") || "main" : "";
      return store.addProject({ name: body.name || basename(path), path, base, review: body.review ?? 1 });
    },
    "PATCH /api/projects/:id": (_r, p, body) => {
      if (body.base !== undefined && !String(body.base).trim()) throw new Error("base branch is required");
      return store.updateProject(Number(p.id), roles(pick(body, PROJECT_FIELDS)));
    },
    "DELETE /api/projects/:id": (_r, p) => store.deleteProject(Number(p.id)),
    "POST /api/projects/:id/orchestrator": (_r, p) => pipe.startOrchestrator(Number(p.id)),
    "POST /api/projects/:id/orchestrator/say": (_r, p, body) => pipe.sayToOrchestrator(Number(p.id), String(body.text)),

    "POST /api/cards": (_r, _p, body) => {
      const project = body.project_id ? store.project(Number(body.project_id)) : store.projectByName(String(body.project));
      if (!project) throw new Error(`unknown project '${body.project ?? body.project_id}'`);
      if (!String(body.title ?? "").trim()) throw new Error("title is required");
      const c = store.addCard({
        project_id: project.id,
        title: String(body.title).trim(),
        brief: String(body.brief ?? ""),
        lane: body.lane === "backlog" ? "backlog" : "todo",
        review: body.review === undefined ? project.review : Number(Boolean(body.review)),
        worktree: body.worktree === undefined ? 1 : Number(Boolean(body.worktree)),
        ...roles({ worker: body.worker ?? null, reviewer: body.reviewer ?? null }),
      });
      pipe.startQueued();
      return c;
    },
    "GET /api/cards/:id": (_r, p) => ({ ...card(p.id!), events: store.events(Number(p.id)) }),
    "PATCH /api/cards/:id": (_r, p, body) => {
      const c = card(p.id!);
      const patch = roles(pick(body, CARD_FIELDS));
      if (c.workspace_id && ("worktree" in patch || "worker" in patch)) throw new Error("the worker already started");
      return store.updateCard(c.id, patch);
    },
    "DELETE /api/cards/:id": (_r, p) => {
      if (card(p.id!).workspace_id) throw new Error("finish the card first (it still has a herdr workspace)");
      store.deleteCard(Number(p.id));
    },
    "POST /api/cards/:id/move": async (_r, p, body) => {
      if (!LANES.includes(body.lane)) throw new Error(`unknown lane '${body.lane}'`);
      const c = await pipe.move(Number(p.id), body.lane as Lane);
      pipe.startQueued();
      return c;
    },
    "POST /api/cards/:id/done": (_r, p, body) => pipe.done(Number(p.id), String(body.summary ?? "")),
    "POST /api/cards/:id/review": (_r, p, body) => pipe.review(Number(p.id), Boolean(body.approve), String(body.notes ?? "")),
    "POST /api/cards/:id/ask": (_r, p, body) => pipe.ask(Number(p.id), String(body.question)),
    "POST /api/cards/:id/reply": (_r, p, body) => pipe.reply(Number(p.id), String(body.text)),
    "POST /api/cards/:id/focus": (_r, p) => pipe.focus(Number(p.id)),

    "POST /api/automations": (_r, _p, body) => {
      parseTrigger(String(body.trigger));
      const project = body.project_id ? store.project(Number(body.project_id)) : store.projectByName(String(body.project));
      if (!project) throw new Error(`unknown project '${body.project ?? body.project_id}'`);
      const title = String(body.title ?? "").trim();
      if (!title) throw new Error("title is required");
      const base = slug(title);
      let name = base;
      for (let n = 2; store.automationByName(name); n++) name = `${base}-${n}`;
      return store.addAutomation({
        name,
        project_id: project.id,
        trigger: String(body.trigger),
        title,
        brief: String(body.brief ?? ""),
        worktree: body.worktree === undefined ? 1 : Number(Boolean(body.worktree)),
        review: body.review === undefined ? project.review : Number(Boolean(body.review)),
        ...roles({ worker: body.worker ?? null, reviewer: body.reviewer ?? null }),
      });
    },
    "PATCH /api/automations/:id": (_r, p, body) => {
      const a = store.automation(Number(p.id));
      if (!a) throw new Error(`no automation #${p.id}`);
      const patch = roles(pick(body, AUTOMATION_FIELDS));
      if (patch.title !== undefined) {
        patch.title = String(patch.title).trim();
        if (!patch.title) throw new Error("title is required");
      }
      if (patch.trigger !== undefined) {
        patch.trigger = String(patch.trigger);
        // Count the new schedule from now: otherwise a slot already past today looks missed and fires.
        if (!Bun.deepEquals(parseTrigger(patch.trigger), parseTrigger(a.trigger))) patch.last_run_at = Date.now();
      }
      return store.updateAutomation(a.id, patch);
    },
    "DELETE /api/automations/:id": (_r, p) => store.deleteAutomation(Number(p.id)),
    "POST /api/automations/:id/run": async (_r, p) => {
      const a = store.automation(Number(p.id)) ?? store.automationByName(p.id!);
      if (!a) throw new Error(`no automation '${p.id}'`);
      const c = await pipe.fire(a);
      if (!c) throw new Error(`skipped: automation '${a.name}' still has a card in progress`);
      pipe.startQueued();
      return c;
    },
  };

  const token = loadToken(HOME);
  type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Response | Promise<Response>;
  const guarded = (h: Handler): Handler => (req, server) => gate(req, server.requestIP(req)?.address ?? "", token, PORT) ?? h(req, server);

  const routes: Record<string, Record<string, Handler>> = {};
  for (const [key, handler] of Object.entries(api)) {
    const [method, path] = key.split(" ") as [string, string];
    (routes[path] ??= {})[method] = guarded(async (req) => {
      try {
        const body = method === "GET" || method === "DELETE" ? {} : await req.json().catch(() => ({}));
        return Response.json((await handler(req, req.params, body)) ?? { ok: true });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    });
  }

  const page = Bun.file(new URL("../web/index.html", import.meta.url).pathname);
  const docs = Bun.file(new URL("../web/docs.html", import.meta.url).pathname);
  const script = (relative: string) => {
    const file = Bun.file(new URL(relative, import.meta.url).pathname);
    return guarded(() => new Response(file, { headers: { "content-type": "text/javascript" } }));
  };
  Bun.serve({
    hostname: HOST,
    port: PORT,
    routes: { ...routes, "/": guarded(() => new Response(page, { headers: { "content-type": "text/html" } })),
      "/docs": guarded(() => new Response(docs, { headers: { "content-type": "text/html" } })),
      "/theme.js": script("../web/theme.js"),
      "/vendor/marked.js": script("../node_modules/marked/lib/marked.umd.js"),
      "/vendor/purify.js": script("../node_modules/dompurify/dist/purify.min.js"),
    },
    fetch: () => Response.json({ error: "not found" }, { status: 404 }),
  });

  pipe.recover();
  const tick = () => pipe.tick().catch((e) => console.error(`tick: ${e.message}`));
  setInterval(tick, TICK_MS);
  tick();
  console.log(`herdrboard on http://${HOST}:${PORT} (state in ${HOME}); other devices: \`hb url\``);
}
