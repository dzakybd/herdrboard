// Thin wrapper over the `herdr` CLI. Every call shells out and parses the JSON
// reply; server errors arrive as JSON on stderr with exit status 1.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Spot {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface Herdr {
  worktreeCreate(repo: string, branch: string, base: string): Promise<Spot & { path: string }>;
  /** A tab in the herdr workspace whose checkout is `cwd` (created if missing). */
  tabIn(cwd: string, label: string): Promise<Spot>;
  split(paneId: string, cwd: string): Promise<string>;
  run(paneId: string, command: string): Promise<void>;
  read(paneId: string): Promise<string>;
  /** pane id → status for every live agent. */
  agents(): Promise<Map<string, AgentStatus>>;
  sendKeys(target: string, keys: string[]): Promise<void>;
  rename(paneId: string, name: string): Promise<void>;
  prompt(target: string, text: string): Promise<void>;
  focus(target: string): Promise<void>;
  closePane(paneId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  worktreeRemove(workspaceId: string): Promise<void>;
}

async function herdr(...args: string[]): Promise<any> {
  const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    let message = err.trim() || out.trim();
    try {
      message = JSON.parse(message).error?.message ?? message;
    } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${message}`);
  }
  return out.trim() ? JSON.parse(out).result : null;
}

const spot = (pane: { workspace_id: string; tab_id: string; pane_id: string }): Spot => ({
  workspaceId: pane.workspace_id,
  tabId: pane.tab_id,
  paneId: pane.pane_id,
});

export const cliHerdr: Herdr = {
  async worktreeCreate(repo, branch, base) {
    const r = await herdr("worktree", "create", "--cwd", repo, "--branch", branch, "--base", base, "--no-focus", "--trust-repository");
    return { ...spot(r.root_pane), path: r.worktree.path };
  },

  async tabIn(cwd, label) {
    const list = await herdr("workspace", "list");
    const ws = list.workspaces.find((w: any) => w.worktree?.checkout_path === cwd);
    const r = ws
      ? await herdr("tab", "create", "--workspace", ws.workspace_id, "--cwd", cwd, "--label", label, "--no-focus")
      : await herdr("workspace", "create", "--cwd", cwd, "--label", label, "--no-focus");
    return spot(r.root_pane);
  },

  async split(paneId, cwd) {
    const r = await herdr("pane", "split", paneId, "--direction", "right", "--cwd", cwd, "--no-focus");
    return r.pane.pane_id;
  },

  async run(paneId, command) {
    await herdr("pane", "run", paneId, command);
  },

  async read(paneId) {
    const proc = Bun.spawn(["herdr", "pane", "read", paneId, "--source", "visible"], { stdout: "pipe", stderr: "ignore" });
    return new Response(proc.stdout).text();
  },

  async agents() {
    const r = await herdr("agent", "list");
    return new Map(r.agents.map((a: any) => [a.pane_id, a.agent_status as AgentStatus]));
  },

  async sendKeys(target, keys) {
    await herdr("agent", "send-keys", target, ...keys);
  },

  async rename(paneId, name) {
    await herdr("agent", "rename", paneId, name);
  },

  async prompt(target, text) {
    await herdr("agent", "prompt", target, text);
  },

  async focus(target) {
    await herdr("agent", "focus", target);
  },

  async closePane(paneId) {
    await herdr("pane", "close", paneId);
  },

  async closeTab(tabId) {
    await herdr("tab", "close", tabId);
  },

  async worktreeRemove(workspaceId) {
    await herdr("worktree", "remove", "--workspace", workspaceId);
  },
};
