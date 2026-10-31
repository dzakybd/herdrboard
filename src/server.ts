import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { LANES, Store, type Lane, type Settings } from "./db.ts";
import { gate, loadToken } from "./auth.ts";
import { cliHerdr } from "./herdr.ts";
import { Pipeline } from "./pipeline.ts";
import { defaultSettings, EFFORTS, MODES, storeRole, validateRole } from "./profiles.ts";
import { nextDue, parseTrigger } from "./scheduler.ts";

export const HOME = process.env.HB_HOME ?? `${homedir()}/.herdrboard`;
export const PORT = Number(process.env.HB_PORT ?? 7420);
const HOST = process.env.HB_HOST ?? "0.0.0.0";
const TICK_MS = 3000;

const PROJECT_FIELDS = ["name", "base", "review", "orchestrator", "worker", "reviewer"];
const CARD_FIELDS = ["title", "brief", "review", "worktree", "worker", "reviewer"];
const AUTOMATION_FIELDS = ["name", "project_id", "trigger", "title", "brief", "worktree", "review", "worker", "reviewer", "enabled"];

function pick(body: Record<string, unknown>, fields: string[]): Record<string, any> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => fields.includes(k)));
}

function git(path: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", path, ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function validateSettings(s: Settings): Settings {
  if (!Array.isArray(s.profiles) || !s.profiles.length) throw new Error("at least one profile is required");
  for (const p of s.profiles) if (!p.name?.trim() || !p.command?.trim()) throw new Error("each profile needs a name and a command");
  const roles = {} as Settings["roles"];
  for (const role of ["orchestrator", "worker", "reviewer"] as const) {
    const cfg = validateRole(s.roles?.[role] ?? {}, s.profiles);
    if (!cfg.profile) throw new Error(`${role} needs a profile`);
    roles[role] = cfg as Settings["roles"][typeof role];
  }
  if (!(s.maxWorkers >= 1) || !(s.maxRounds >= 0)) throw new Error("maxWorkers must be ≥ 1 and maxRounds ≥ 0");
  return { profiles: s.profiles, roles, maxWorkers: Number(s.maxWorkers), maxRounds: Number(s.maxRounds) };
}

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
    "PUT /api/settings": (_r, _p, body) => {
      store.saveSettings(validateSettings(body));
      return store.settings();
    },

    "POST /api/projects": (_r, _p, body) => {
      const raw = String(body.path ?? "").replace(/^~(?=\/|$)/, homedir());
      if (!existsSync(raw)) throw new Error(`no such folder: ${raw}`);
      const path = realpathSync(raw);
      const top = git(path, "rev-parse", "--show-toplevel");
      if (top !== path) throw new Error(top ? `use the repository root: ${top}` : `${path} is not a git repository`);
      const base = body.base || git(path, "symbolic-ref", "--short", "HEAD") || "main";
      return store.addProject({ name: body.name || basename(path), path, base, review: body.review ?? 1 });
    },
    "PATCH /api/projects/:id": (_r, p, body) => store.updateProject(Number(p.id), roles(pick(body, PROJECT_FIELDS))),
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
      if (!body.name || !body.title) throw new Error("name and title are required");
      return store.addAutomation({
        name: String(body.name),
        project_id: project.id,
        trigger: String(body.trigger),
        title: String(body.title),
        brief: String(body.brief ?? ""),
        worktree: body.worktree === undefined ? 1 : Number(Boolean(body.worktree)),
        review: body.review === undefined ? project.review : Number(Boolean(body.review)),
        ...roles({ worker: body.worker ?? null, reviewer: body.reviewer ?? null }),
      });
    },
    "PATCH /api/automations/:id": (_r, p, body) => {
      if (body.trigger !== undefined) parseTrigger(String(body.trigger));
      return store.updateAutomation(Number(p.id), roles(pick(body, AUTOMATION_FIELDS)));
    },
    "DELETE /api/automations/:id": (_r, p) => store.deleteAutomation(Number(p.id)),
    "POST /api/automations/:id/run": (_r, p) => {
      const a = store.automation(Number(p.id)) ?? store.automationByName(p.id!);
      if (!a) throw new Error(`no automation '${p.id}'`);
      const c = pipe.fire(a);
      if (!c) throw new Error(`skipped: automation '${a.name}' still has an open card`);
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
  Bun.serve({
    hostname: HOST,
    port: PORT,
    routes: { ...routes, "/": guarded(() => new Response(page, { headers: { "content-type": "text/html" } })) },
    fetch: () => Response.json({ error: "not found" }, { status: 404 }),
  });

  pipe.recover();
  const tick = () => pipe.tick().catch((e) => console.error(`tick: ${e.message}`));
  setInterval(tick, TICK_MS);
  tick();
  console.log(`herdrboard on http://${HOST}:${PORT} (state in ${HOME}); other devices: \`hb url\``);
}
