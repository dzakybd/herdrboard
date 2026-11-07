#!/usr/bin/env bun
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";

const URL_BASE = process.env.HB_URL ?? `http://127.0.0.1:${process.env.HB_PORT ?? 7420}`;

const HELP = `hb: herdrboard CLI

  hb serve                                   run the board (web UI + tick loop)
  hb restart                                 restart the service; running agents are not touched
  hb url                                     link for your phone/other devices (carries the access token)

  hb export [file]                           save projects, automations, card history and settings as JSON
  hb import <file> [--dry-run] [--path PROJECT=PATH]... [--skip PROJECT]...
                                             check the file against this machine, then import it

  hb project add <path> [--name N] [--base B] [--no-review]
  hb project list

  hb card add "<title>" [--brief TEXT | --brief-file F] [--project P]
                        [--attach FILE]... [--backlog] [--no-review] [--no-worktree] [--worker PROFILE] [--reviewer PROFILE]
                        [--model M] [--effort low|medium|high|xhigh|max] [--mode bypassPermissions|acceptEdits|auto|manual|dontAsk|plan]
                        (--model/--effort/--mode apply to the worker; unset = the board's defaults)
  hb card attach <id> <file>...              add images or files to a card (the agent gets their paths)
  hb card list [--project P] [--lane L]
  hb card show <id>
  hb card move <id> <backlog|todo|done>

  hb done --summary "<what you did>"         worker: task finished   (card from $HB_CARD or --card)
  hb review --approve | --changes "<notes>"  reviewer: verdict
  hb ask "<question>"                        agent: ask the human, card goes to Needs you

  hb automation list
  hb automation add --title T --trigger "every 30m" [--brief B] [--project P] [--no-worktree] [--no-review]
                    [--worker PROFILE] [--model M] [--effort E] [--mode MODE]
  hb automation run <name>

  hb telegram setup [bot-token]              connect a bot from @BotFather (asks for the token if not given),
                                             then /link it in a group with Topics
  hb telegram status
  hb telegram off

  hb orch start [project]                    start (or focus) the project's orchestrator in herdr
  hb orch say [project] "<text>"

Project defaults to $HB_PROJECT, then the registered project containing the current folder.
`;

// An agent's `hb done` / `hb ask` must survive a board restart, so inside an agent
// a refused connection is retried for a while instead of failing the report.
const PATIENT_MS = process.env.HB_CARD || process.env.HB_ROLE ? 60_000 : 0;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response | undefined;
  const give_up = Date.now() + PATIENT_MS;
  while (!res) {
    try {
      res = await fetch(URL_BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if ((e as { code?: string }).code !== "ECONNREFUSED" || Date.now() >= give_up) die(`herdrboard is not running at ${URL_BASE} (start it with \`hb serve\`)`);
      await Bun.sleep(1000);
    }
  }
  const data = await res.json();
  if (!res.ok) die(data.error);
  return data;
}

function uploads(paths: string[]): { name: string; data: string }[] {
  return paths.map((p) => {
    try {
      return { name: p.split("/").pop()!, data: readFileSync(p).toString("base64") };
    } catch {
      die(`can't read ${p}`);
    }
  });
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

switch (cmd === "card" || cmd === "project" || cmd === "automation" || cmd === "orch" || cmd === "telegram" ? `${cmd} ${sub}` : cmd) {
  case "serve": {
    (await import("./server.ts")).serve();
    break;
  }
  case "export": {
    const bundle = await call("GET", "/api/export");
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    if (sub) writeFileSync(sub, text);
    else process.stdout.write(text);
    console.error(`exported ${bundle.projects.length} project(s), ${bundle.automations.length} automation(s), ${bundle.cards.length} card(s)`);
    if (bundle.in_progress_left_out) console.error(`left out ${bundle.in_progress_left_out} in-progress card(s): finish them first if you want them in the export`);
    break;
  }
  case "import": {
    const { values, positionals } = args({ "dry-run": { type: "boolean" }, path: { type: "string", multiple: true }, skip: { type: "string", multiple: true } }, process.argv.slice(3));
    if (!positionals[0]) die("usage: hb import <file> [--dry-run] [--path PROJECT=PATH]... [--skip PROJECT]...");
    let bundle: unknown;
    try {
      bundle = JSON.parse(readFileSync(positionals[0], "utf8"));
    } catch (e) {
      die(`can't read ${positionals[0]}: ${(e as Error).message}`);
    }
    const paths: Record<string, string> = {};
    for (const pair of (values.path ?? []) as string[]) {
      const at = pair.indexOf("=");
      if (at < 1) die(`--path needs PROJECT=PATH, got '${pair}'`);
      paths[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const body = { bundle, paths, skip: values.skip };
    const plan = await call("POST", "/api/import/check", body);
    for (const p of plan.projects) console.log(`${p.problem ? "problem" : p.action.padEnd(7)}  ${p.name}  ${p.path}${p.note ? `  (${p.note})` : ""}`);
    console.log(`automations: ${plan.automations.add} new, ${plan.automations.existing} already here, ${plan.automations.skipped} skipped`);
    console.log(`cards: ${plan.cards.add} new, ${plan.cards.existing} already here, ${plan.cards.skipped} skipped`);
    for (const w of plan.warnings) console.log(`warning: ${w}`);
    for (const e of plan.errors) console.error(`error: ${e}`);
    if (!plan.ok) die("nothing imported: fix these with --path or --skip");
    if (values["dry-run"]) break;
    await call("POST", "/api/import", body);
    console.log("imported");
    break;
  }
  case "restart": {
    const mac = process.platform === "darwin";
    const cmd = mac
      ? ["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/dev.dzaky.herdrboard`]
      : ["systemctl", "--user", "restart", "dev.dzaky.herdrboard"];
    const out = Bun.spawnSync(cmd, { stderr: "pipe" });
    if (out.exitCode !== 0) die(`${cmd.join(" ")} failed: ${out.stderr.toString().trim()}`);
    for (let i = 0; i < 90; i++) {
      await Bun.sleep(1000);
      try {
        await fetch(`${URL_BASE}/api/state`, { headers: { "content-type": "application/json" } });
        console.log("herdrboard restarted; running agents were not touched");
        process.exit(0);
      } catch {}
    }
    die("herdrboard did not come back within 90s; see ~/.herdrboard/serve.log");
  }
  case "url": {
    const { HOME, PORT } = await import("./server.ts");
    const { loadToken } = await import("./auth.ts");
    const bonjour = process.platform === "darwin" ? Bun.spawnSync(["scutil", "--get", "LocalHostName"]).stdout.toString().trim().toLowerCase() : "";
    const host = bonjour ? `${bonjour}.local` : hostname() || "127.0.0.1";
    console.log(`http://${host}:${PORT}/?token=${loadToken(HOME)}`);
    break;
  }
  case "project add": {
    const { values, positionals } = args({ name: { type: "string" }, base: { type: "string" }, "no-review": { type: "boolean" } });
    const p = await call("POST", "/api/projects", { path: positionals[0] ?? process.cwd(), name: values.name, base: values.base, review: values["no-review"] ? 0 : 1 });
    console.log(`project ${p.name} → ${p.path} (${p.base ? `base ${p.base}` : "folder"})`);
    break;
  }
  case "project list": {
    for (const p of (await call("GET", "/api/state")).projects) console.log(`${p.name}  ${p.path}  ${p.base ? `base=${p.base}` : "folder"}  review=${p.review ? "on" : "off"}`);
    break;
  }
  case "card add": {
    const { values, positionals } = args({
      brief: { type: "string" },
      "brief-file": { type: "string" },
      attach: { type: "string", multiple: true },
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
      attachments: uploads(values.attach ?? []),
      worker: workerConfig(values),
      reviewer: values.reviewer,
    });
    console.log(line(c));
    break;
  }
  case "card attach": {
    const [id, ...files] = rest;
    if (!id || !files.length) die("usage: hb card attach <id> <file>...");
    const all = await call("POST", `/api/cards/${id}/attachments`, { attachments: uploads(files) });
    console.log(`#${id} attachments: ${all.map((a: any) => a.name).join(", ")}`);
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
  case "telegram setup":
  case "telegram status":
  case "telegram off": {
    // Without an argument the token is asked for, so it stays out of shell history.
    const token = sub === "setup" ? (rest[0] ?? prompt("Bot token from @BotFather:")) : null;
    if (sub === "setup" && !token) die("usage: hb telegram setup [bot-token]");
    const s =
      sub === "setup" ? await call("POST", "/api/telegram", { token }) : sub === "off" ? await call("DELETE", "/api/telegram") : await call("GET", "/api/telegram");
    if (!s.enabled) console.log("telegram is off");
    else if (s.linked) console.log(`telegram: @${s.bot}, linked`);
    else console.log(`telegram: @${s.bot}, not linked yet. In your Telegram group (Topics on, bot added as admin with Manage Topics), send:\n  /link ${s.code}`);
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
