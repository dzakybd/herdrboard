import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { attachmentPath, listAttachments, removeAttachments, saveAttachments } from "./attachments.ts";
import { finishCleanup } from "./cleanup.ts";
import { LANES, Store, type Lane, type PullVerdict } from "./db.ts";
import { gate, loadToken, login } from "./auth.ts";
import { expandHome, listDirs } from "./fs.ts";
import { cliHerdr } from "./herdr.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { Pipeline, slug } from "./pipeline.ts";
import { defaultSettings, EFFORTS, MODES, storeRole, validateSettings } from "./profiles.ts";
import { nextDue, parseTrigger } from "./scheduler.ts";
import { git, inspectPath } from "./inspect.ts";
import { Telegram } from "./telegram.ts";
import { applyImport, exportBundle, planImport } from "./transfer.ts";

export const HOME = process.env.HB_HOME ?? `${homedir()}/.herdrboard`;
export const PORT = Number(process.env.HB_PORT ?? 7320);
// Other devices come in through `tailscale serve`; HB_HOST=0.0.0.0 opens the LAN instead.
export const HOST = process.env.HB_HOST ?? "127.0.0.1";
const TICK_MS = 3000;
const DRAIN_MS = 60_000;

const PROJECT_FIELDS = ["name", "base", "review", "orchestrator", "worker", "reviewer"];
const CARD_FIELDS = ["title", "brief", "review", "worktree", "worker", "reviewer"];
const AUTOMATION_FIELDS = ["project_id", "trigger", "title", "brief", "worktree", "review", "worker", "reviewer", "enabled"];

/** `gh pr review` as the user, killed after a minute so a hung network can't hold the Telegram bot. */
async function ghReview(repo: string, number: number, verdict: PullVerdict["verdict"]): Promise<void> {
  const flags = verdict === "approve" ? ["--approve"] : ["--request-changes", "--body", "Requesting changes: see my review comments on this PR."];
  const proc = Bun.spawn(["gh", "pr", "review", String(number), `--repo=${repo}`, ...flags], { stdout: "ignore", stderr: "pipe", timeout: 60_000 });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh pr review: ${(await new Response(proc.stderr).text()).trim() || (proc.signalCode ? "timed out" : `exit ${code}`)}`);
}

/** `owner/repo#123=approve|changes`, as `hb done --pr` sends them. */
export function parseVerdicts(raw: unknown): PullVerdict[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("prs must be a list");
  return raw.map((v) => {
    const m = String(v).trim().match(/^([\w.-]+\/[\w.-]+)#(\d+)=(approve|changes)$/);
    if (!m) throw new Error(`--pr '${v}' should look like owner/repo#123=approve or =changes`);
    return { repo: m[1]!, number: Number(m[2]), verdict: m[3] as PullVerdict["verdict"] };
  });
}

function pick(body: Record<string, unknown>, fields: string[]): Record<string, any> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => fields.includes(k)));
}

const ROLE_FIELDS = ["orchestrator", "worker", "reviewer"];

export function serve(): void {
  mkdirSync(HOME, { recursive: true });
  if (migrateSqlite(`${HOME}/herdrboard.db`, `${HOME}/herdrboard.json`)) console.log("moved state from herdrboard.db to herdrboard.json");
  const store = new Store(`${HOME}/herdrboard.json`, () => defaultSettings());
  const telegram = new Telegram(HOME, {
    reply: (id, text) => pipe.reply(id, text),
    projects: () => store.projects(),
    cards: () => store.cards().map((c) => ({ ...c, agent_status: agentStatus(pipe.activePane(c)) })),
    events: (id) => store.events(id),
    addCard: (project, title, brief) => createCard({ project, title, brief }),
    finish: async (id) => {
      const c = await pipe.finish(id);
      pipe.startQueued();
      return c;
    },
    runAutomation: (name) => runAutomation(name),
    submitVerdict: (cardId, key, index, verdict) => pipe.submitVerdict(cardId, key, index, verdict),
  });
  const pipe = new Pipeline(store, cliHerdr, { home: HOME, url: `http://127.0.0.1:${PORT}`, cleanup: finishCleanup, notify: (e) => telegram.notify(e), submitReview: ghReview });

  /** Role override fields (name, config object or empty) → validated JSON column values. */
  const roles = <T extends Record<string, any>>(patch: T): T => {
    const profiles = store.settings().profiles;
    const out: Record<string, any> = { ...patch };
    for (const f of ROLE_FIELDS) if (f in out) out[f] = storeRole(out[f], profiles);
    return out as T;
  };

  /** The board, the CLI and Telegram all create cards through this. */
  const createCard = (body: any) => {
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
    // Before startQueued: the worker's brief lists the files it finds.
    try {
      saveAttachments(HOME, c.id, body.attachments);
    } catch (e) {
      store.deleteCard(c.id);
      removeAttachments(HOME, c.id);
      throw e;
    }
    pipe.startQueued();
    return store.card(c.id)!;
  };

  const runAutomation = async (key: string) => {
    const a = store.automation(Number(key)) ?? store.automationByName(key);
    if (!a) throw new Error(`no automation '${key}'`);
    const c = await pipe.fire(a);
    if (!c) throw new Error(`not started: automation '${a.name}' has a card in progress, or its run is waiting (see the card's activity)`);
    pipe.startQueued();
    return c;
  };

  const agentStatus = (pane: string | null) => (pane && pipe.statuses.get(pane)) || null;

  const card = (id: string) => {
    const c = store.card(Number(id));
    if (!c) throw new Error(`no card #${id}`);
    return c;
  };

  const api: Record<string, (req: Request, p: Record<string, string>, body: any) => unknown> = {
    "GET /api/state": () => {
      const now = Date.now();
      return {
        lanes: LANES,
        efforts: EFFORTS,
        modes: MODES,
        settings: store.settings(),
        projects: store.projects().map((p) => ({ ...p, orch_status: agentStatus(p.orch_pane) })),
        cards: store.cards().map((c) => ({ ...c, agent_status: agentStatus(pipe.activePane(c)) })),
        automations: store.automations().map((a) => ({
          ...a,
          next_due: nextDue(parseTrigger(a.trigger), Math.max(a.last_run_at, a.created_at), now),
          blocked: pipe.blocked(a),
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

    "GET /api/telegram": () => telegram.status(),
    "POST /api/telegram": (_r, _p, body) => {
      const token = String(body.token ?? "").trim();
      if (!token) throw new Error("a bot token from @BotFather is required");
      return telegram.setup(token);
    },
    "DELETE /api/telegram": () => telegram.disable(),

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
    "DELETE /api/projects/:id": (_r, p) => {
      const gone = store.cards().filter((c) => c.project_id === Number(p.id));
      store.deleteProject(Number(p.id));
      for (const c of gone) telegram.notify({ kind: "deleted", card: c });
    },
    "POST /api/projects/:id/orchestrator": (_r, p) => pipe.startOrchestrator(Number(p.id)),
    "POST /api/projects/:id/orchestrator/say": (_r, p, body) => pipe.sayToOrchestrator(Number(p.id), String(body.text)),

    "POST /api/cards": (_r, _p, body) => createCard(body),
    "POST /api/cards/:id/attachments": (_r, p, body) => {
      const c = card(p.id!);
      if (c.lane === "done") throw new Error("the card is done");
      saveAttachments(HOME, c.id, body.attachments);
      return listAttachments(HOME, c.id);
    },
    "GET /api/cards/:id": (_r, p) => ({ ...card(p.id!), events: store.events(Number(p.id)), attachments: listAttachments(HOME, Number(p.id)) }),
    "PATCH /api/cards/:id": (_r, p, body) => {
      const c = card(p.id!);
      const patch = roles(pick(body, CARD_FIELDS));
      if (c.workspace_id && ("worktree" in patch || "worker" in patch)) throw new Error("the worker already started");
      return store.updateCard(c.id, patch);
    },
    "DELETE /api/cards/:id": (_r, p) => {
      const c = card(p.id!);
      if (c.workspace_id) throw new Error("finish the card first (it still has a herdr workspace)");
      store.deleteCard(c.id);
      removeAttachments(HOME, c.id);
      telegram.notify({ kind: "deleted", card: c });
    },
    "POST /api/cards/:id/move": async (_r, p, body) => {
      if (!LANES.includes(body.lane)) throw new Error(`unknown lane '${body.lane}'`);
      const c = await pipe.move(Number(p.id), body.lane as Lane);
      pipe.startQueued();
      return c;
    },
    "POST /api/cards/:id/done": (_r, p, body) => pipe.done(Number(p.id), String(body.summary ?? ""), { quiet: Boolean(body.quiet), prs: parseVerdicts(body.prs) }),
    "POST /api/cards/:id/review": (_r, p, body) => pipe.review(Number(p.id), Boolean(body.approve), String(body.notes ?? "")),
    "POST /api/cards/:id/ask": (_r, p, body) => pipe.ask(Number(p.id), String(body.question)),
    "POST /api/cards/:id/reply": (_r, p, body) => pipe.reply(Number(p.id), String(body.text ?? ""), body.attachments, body.review === undefined ? undefined : Boolean(body.review)),
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
      if (patch.project_id !== undefined) {
        patch.project_id = Number(patch.project_id);
        if (!store.project(patch.project_id)) throw new Error(`no project #${body.project_id}`);
      }
      if (patch.title !== undefined) {
        patch.title = String(patch.title).trim();
        if (!patch.title) throw new Error("title is required");
      }
      if (patch.trigger !== undefined) {
        patch.trigger = String(patch.trigger);
        // Count the new schedule from now: otherwise a slot already past today looks missed and fires.
        if (!Bun.deepEquals(parseTrigger(patch.trigger), parseTrigger(a.trigger))) patch.last_run_at = Date.now();
      }
      // Same for re-enabling: the slots missed while it was paused must not fire.
      if (patch.enabled && !a.enabled) patch.last_run_at = Date.now();
      return store.updateAutomation(a.id, patch);
    },
    "GET /api/automations/:id/runs": (_r, p) => {
      const a = store.automation(Number(p.id));
      if (!a) throw new Error(`no automation #${p.id}`);
      // A card's earlier runs are over; only its latest one has the card's lane.
      const latest = new Set<number>();
      const runs = store.runs(a.id).map((r) => {
        const c = store.card(r.card_id)!;
        const lane = latest.has(c.id) ? "done" : c.lane;
        latest.add(c.id);
        return { id: c.id, title: c.title, lane, summary: r.summary, created_at: r.at, branch: c.branch };
      });
      // Cards from before runs were recorded, one per run.
      const older = store.automationCards(a.id).filter((c) => !latest.has(c.id)).map(({ id, title, lane, summary, created_at, branch }) => ({ id, title, lane, summary, created_at, branch }));
      return [...runs, ...older].sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    },
    "DELETE /api/automations/:id": (_r, p) => store.deleteAutomation(Number(p.id)),
    "POST /api/automations/:id/run": (_r, p) => runAutomation(p.id!),
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

  // Uploaded files are untrusted: only raster images show inline, the rest download, and none can run script.
  const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  routes["/api/cards/:id/attachments/:name"] = {
    GET: guarded((req) => {
      const path = attachmentPath(HOME, Number(req.params.id), req.params.name!);
      if (!path) return Response.json({ error: "no such attachment" }, { status: 404 });
      const file = Bun.file(path);
      const inline = INLINE.has(file.type.split(";")[0]!);
      return new Response(file, {
        headers: {
          "content-type": inline ? file.type : "application/octet-stream",
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${req.params.name}"`,
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  };

  const page = Bun.file(new URL("../web/index.html", import.meta.url).pathname);
  const docs = Bun.file(new URL("../web/docs.html", import.meta.url).pathname);
  const script = (relative: string) => {
    const file = Bun.file(new URL(relative, import.meta.url).pathname);
    return guarded(() => new Response(file, { headers: { "content-type": "text/javascript" } }));
  };
  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    routes: { ...routes, "/": guarded(() => new Response(page, { headers: { "content-type": "text/html" } })),
      "/docs": guarded(() => new Response(docs, { headers: { "content-type": "text/html" } })),
      // The only route outside guarded(): it is how other devices get the cookie.
      "/login": { POST: (req) => login(req, token) },
      "/theme.js": script("../web/theme.js"),
      "/vendor/marked.js": script("../node_modules/marked/lib/marked.umd.js"),
      "/vendor/purify.js": script("../node_modules/dompurify/dist/purify.min.js"),
    },
    fetch: () => Response.json({ error: "not found" }, { status: 404 }),
  });

  pipe.recover();
  telegram.start();
  const tick = () => pipe.tick().catch((e) => console.error(`tick: ${e.message}`));
  // Attachments of long-finished cards would pile up; a done card keeps them for 30 days.
  const prune = () => {
    const old = Date.now() - 30 * 86_400_000;
    for (const c of store.cards()) if (c.lane === "done" && c.updated_at < old) removeAttachments(HOME, c.id);
  };
  prune();
  setInterval(prune, 86_400_000);
  const ticker = setInterval(tick, TICK_MS);
  tick();

  // A restart (update, launchd, systemd) must not cut a launch in half: agents run in
  // herdr and carry on by themselves, but a worktree being set up would be orphaned.
  // Finish the requests in flight, let launches land, then exit. `hb` retries meanwhile.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: draining, agents keep running`);
    clearInterval(ticker);
    telegram.stop();
    await server.stop();
    const clean = await pipe.drain(DRAIN_MS);
    console.log(clean ? "drained, exiting" : `launches still running after ${DRAIN_MS / 1000}s, exiting anyway`);
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));
  console.log(`herdrboard on http://${HOST}:${PORT} (state in ${HOME}); other devices: \`hb url\``);
}
