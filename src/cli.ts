#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";

const URL_BASE = process.env.HB_URL ?? `http://127.0.0.1:${process.env.HB_PORT ?? 7420}`;

const HELP = `hb: herdrboard CLI

  hb serve                                   run the board (web UI + tick loop)
  hb url                                     link for your phone/other devices (carries the access token)

  hb project add <path> [--name N] [--base B] [--no-review]
  hb project list

  hb card add "<title>" [--brief TEXT | --brief-file F] [--project P]
                        [--backlog] [--no-review] [--no-worktree] [--worker PROFILE] [--reviewer PROFILE]
                        [--model M] [--effort low|medium|high|xhigh|max] [--mode bypassPermissions|acceptEdits|auto|manual|dontAsk|plan]
                        (--model/--effort/--mode apply to the worker; unset = the board's defaults)
  hb card list [--project P] [--lane L]
  hb card show <id>
  hb card move <id> <backlog|todo|done>

  hb done --summary "<what you did>"         worker: task finished   (card from $HB_CARD or --card)
  hb review --approve | --changes "<notes>"  reviewer: verdict
  hb ask "<question>"                        agent: ask the human, card goes to Needs you

  hb automation list
  hb automation add --name N --trigger "every 30m" --title T [--brief B] [--project P] [--no-worktree] [--no-review]
                    [--worker PROFILE] [--model M] [--effort E] [--mode MODE]
  hb automation run <name>

  hb orch start [project]                    start (or focus) the project's orchestrator in herdr
  hb orch say [project] "<text>"

Project defaults to $HB_PROJECT, then the registered project containing the current folder.
`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(URL_BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    die(`herdrboard is not running at ${URL_BASE} (start it with \`hb serve\`)`);
  }
  const data = await res.json();
  if (!res.ok) die(data.error);
  return data;
}

function die(msg: string): never {
  console.error(`hb: ${msg}`);
  process.exit(1);
}

async function projectName(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.HB_PROJECT) return process.env.HB_PROJECT;
  const cwd = realpathSync(process.cwd());
  const { projects, cards } = await call("GET", "/api/state");
  const inside = (root: string) => cwd === root || cwd.startsWith(`${root}/`);
  const own = projects.find((p: any) => inside(p.path));
  if (own) return own.name;
  const fromCard = cards.find((c: any) => c.cwd && inside(c.cwd));
  if (fromCard) return projects.find((p: any) => p.id === fromCard.project_id).name;
  die("no project here; pass --project or register one with `hb project add <path>`");
}

function cardId(explicit?: string): string {
  const id = explicit ?? process.env.HB_CARD;
  if (!id) die("no card: pass --card or run inside an agent started by herdrboard ($HB_CARD)");
  return id;
}

function workerConfig(v: Record<string, any>): object | undefined {
  const cfg = { profile: v.worker, model: v.model, effort: v.effort, mode: v.mode };
  return Object.values(cfg).some(Boolean) ? cfg : undefined;
}

function line(c: any): string {
  return `#${c.id}  ${c.lane.padEnd(9)}  ${c.title}${c.attention ? `  (${c.attention.split("\n")[0]})` : ""}`;
}

const [cmd, sub, ...rest] = process.argv.slice(2);
const args = (spec: ParseArgsConfig["options"], from = rest) => {
  if (from.includes("--help") || from.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    const { values, positionals } = parseArgs({ args: from, options: spec, allowPositionals: true });
    return { values: values as Record<string, any>, positionals };
  } catch (e) {
    die(`${(e as Error).message}\nRun \`hb help\` for usage.`);
  }
};

switch (cmd === "card" || cmd === "project" || cmd === "automation" || cmd === "orch" ? `${cmd} ${sub}` : cmd) {
  case "serve": {
    (await import("./server.ts")).serve();
    break;
  }
  case "url": {
    const { HOME, PORT } = await import("./server.ts");
    const { loadToken } = await import("./auth.ts");
    const host = Bun.spawnSync(["scutil", "--get", "LocalHostName"]).stdout.toString().trim().toLowerCase();
    console.log(`http://${host ? `${host}.local` : "127.0.0.1"}:${PORT}/?token=${loadToken(HOME)}`);
    break;
  }
  case "project add": {
    const { values, positionals } = args({ name: { type: "string" }, base: { type: "string" }, "no-review": { type: "boolean" } });
    const p = await call("POST", "/api/projects", { path: positionals[0] ?? process.cwd(), name: values.name, base: values.base, review: values["no-review"] ? 0 : 1 });
    console.log(`project ${p.name} → ${p.path} (base ${p.base})`);
    break;
  }
  case "project list": {
    for (const p of (await call("GET", "/api/state")).projects) console.log(`${p.name}  ${p.path}  base=${p.base}  review=${p.review ? "on" : "off"}`);
    break;
  }
  case "card add": {
    const { values, positionals } = args({
      brief: { type: "string" },
      "brief-file": { type: "string" },
      project: { type: "string" },
      backlog: { type: "boolean" },
      "no-review": { type: "boolean" },
      review: { type: "boolean" },
      "no-worktree": { type: "boolean" },
      worker: { type: "string" },
      reviewer: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      mode: { type: "string" },
    });
    const c = await call("POST", "/api/cards", {
      project: await projectName(values.project as string | undefined),
      title: positionals.join(" "),
      brief: values["brief-file"] ? readFileSync(values["brief-file"] as string, "utf8") : values.brief,
      lane: values.backlog ? "backlog" : "todo",
      review: values["no-review"] ? false : values.review ? true : undefined,
      worktree: values["no-worktree"] ? false : undefined,
      worker: workerConfig(values),
      reviewer: values.reviewer,
    });
    console.log(line(c));
    break;
  }
  case "card list": {
    const { values } = args({ project: { type: "string" }, lane: { type: "string" } });
    const { cards, projects } = await call("GET", "/api/state");
    const project = values.project ? projects.find((p: any) => p.name === values.project) : null;
    for (const c of cards) {
      if (project && c.project_id !== project.id) continue;
      if (values.lane ? c.lane !== values.lane : c.lane === "done") continue;
      console.log(line(c));
    }
    break;
  }
  case "card show": {
    const c = await call("GET", `/api/cards/${rest[0] ?? cardId()}`);
    console.log(`${line(c)}\nbranch: ${c.branch ?? "-"}  cwd: ${c.cwd ?? "-"}  review: ${c.review ? "on" : "off"}  round: ${c.round}`);
    if (c.brief) console.log(`\n${c.brief}`);
    if (c.summary) console.log(`\nsummary: ${c.summary}`);
    console.log("\nlog:");
    for (const e of c.events) console.log(`  ${new Date(e.at).toLocaleString()}  ${e.text}`);
    break;
  }
  case "card move": {
    const [id, lane] = rest;
    if (!id || !lane) die("usage: hb card move <id> <lane>");
    console.log(line(await call("POST", `/api/cards/${id}/move`, { lane })));
    break;
  }
  case "done": {
    const { values } = args({ summary: { type: "string" }, card: { type: "string" } }, [sub ?? "", ...rest].filter(Boolean));
    console.log(line(await call("POST", `/api/cards/${cardId(values.card as string)}/done`, { summary: values.summary ?? "" })));
    break;
  }
  case "review": {
    const { values } = args({ approve: { type: "boolean" }, changes: { type: "string" }, card: { type: "string" } }, [sub ?? "", ...rest].filter(Boolean));
    if (!values.approve && values.changes === undefined) die('usage: hb review --approve | --changes "<notes>"');
    const id = cardId(values.card as string);
    console.log(line(await call("POST", `/api/cards/${id}/review`, { approve: Boolean(values.approve), notes: values.changes ?? "" })));
    break;
  }
  case "ask": {
    const { values, positionals } = args({ card: { type: "string" } }, [sub ?? "", ...rest].filter(Boolean));
    if (!positionals.length) die('usage: hb ask "<question>"');
    console.log(line(await call("POST", `/api/cards/${cardId(values.card as string)}/ask`, { question: positionals.join(" ") })));
    break;
  }
  case "automation list": {
    for (const a of (await call("GET", "/api/state")).automations) {
      console.log(`${a.name}  "${a.trigger}"  ${a.enabled ? "on" : "off"}  next ${new Date(a.next_due).toLocaleString()}  → ${a.title}`);
    }
    break;
  }
  case "automation add": {
    const { values } = args({
      name: { type: "string" },
      trigger: { type: "string" },
      title: { type: "string" },
      brief: { type: "string" },
      project: { type: "string" },
      "no-worktree": { type: "boolean" },
      "no-review": { type: "boolean" },
      worker: { type: "string" },
      reviewer: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      mode: { type: "string" },
    });
    const a = await call("POST", "/api/automations", {
      ...values,
      worker: workerConfig(values),
      project: await projectName(values.project as string | undefined),
      worktree: values["no-worktree"] ? false : undefined,
      review: values["no-review"] ? false : undefined,
    });
    console.log(`automation ${a.name} "${a.trigger}"`);
    break;
  }
  case "automation run": {
    if (!rest[0]) die("usage: hb automation run <name>");
    console.log(line(await call("POST", `/api/automations/${encodeURIComponent(rest[0])}/run`)));
    break;
  }
  case "orch start":
  case "orch say": {
    const { projects } = await call("GET", "/api/state");
    const explicit = sub === "say" && rest.length < 2 ? undefined : rest[0];
    const name = await projectName(explicit);
    const project = projects.find((p: any) => p.name === name) ?? die(`unknown project '${name}'`);
    if (sub === "start") {
      await call("POST", `/api/projects/${project.id}/orchestrator`);
      console.log(`orchestrator for ${name} is running in herdr`);
    } else {
      const text = (explicit ? rest.slice(1) : rest).join(" ");
      if (!text) die('usage: hb orch say [project] "<text>"');
      await call("POST", `/api/projects/${project.id}/orchestrator/say`, { text });
    }
    break;
  }
  default:
    console.log(HELP);
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
