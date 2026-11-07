import { mkdirSync, writeFileSync } from "node:fs";
import { attachmentDir, listAttachments, saveAttachments } from "./attachments.ts";
import { feedbackPrompt, orchestratorBrief, reviewerBrief, workerBrief } from "./briefs.ts";
import type { Cleanup } from "./cleanup.ts";
import type { Automation, Card, Lane, Store } from "./db.ts";
import type { AgentStatus, Herdr } from "./herdr.ts";
import { describeRole, launchCommand, resolveRole } from "./profiles.ts";
import { isDue, parseTrigger } from "./scheduler.ts";

const TRUST_PROMPT = "Yes, I trust this folder";
const LIVE: Lane[] = ["working", "review"];

export interface PipelineOptions {
  home: string; // brief files go to <home>/cards/<id>/
  url: string; // HB_URL handed to agents so `hb` finds this server
  pollMs?: number;
  launchTimeoutMs?: number;
  /** Housekeeping after Finish (branches, folder worktrees). Kept out of Herdr so the pipeline stays testable. */
  cleanup?: Cleanup;
  /** Told when a card starts (or reruns), waits on the human, reaches Ready, or is finished (Telegram). Must not throw. */
  notify?: (event: BoardEvent) => void;
}

export type BoardEvent = { kind: "started" | "needs_you" | "ready" | "done"; card: Card };

export class Pipeline {
  private launching = new Set<number>();
  /** Automations inside fire(): a second Run click or a tick must not prompt the same agent twice. */
  private firing = new Set<number>();
  /** pane id → agent status from the last sync, for the UI. */
  statuses = new Map<string, AgentStatus>();
  private ticking = false;
  private draining = false;
  private pollMs: number;
  private launchTimeoutMs: number;

  constructor(
    readonly store: Store,
    readonly herdr: Herdr,
    private opts: PipelineOptions,
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.launchTimeoutMs = opts.launchTimeoutMs ?? 90_000;
  }

  /** At startup: launches cut off by a restart left cards with no agent pane. */
  recover(): void {
    for (const lane of LIVE) {
      for (const card of this.store.cardsIn(lane)) {
        if (!this.activePane(card)) this.needsYou(card, "herdrboard restarted while this agent was starting. Finish the card and try again.", null);
      }
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking || this.draining) return;
    this.ticking = true;
    try {
      await this.runAutomations(now);
      await this.sync();
      this.startQueued();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * For a planned restart: starts nothing new, then waits (up to `ms`) for the
   * tick and every launch in flight to finish. Running agents live in herdr and
   * are not touched; only a half-done launch would be lost, and this keeps it
   * from being cut off.
   */
  async drain(ms: number): Promise<boolean> {
    this.draining = true;
    const deadline = Date.now() + ms;
    while ((this.launching.size || this.ticking) && Date.now() < deadline) await Bun.sleep(50);
    return !this.launching.size && !this.ticking;
  }

  /** Resolves once every launch in flight has finished (tests use this). */
  async settle(): Promise<void> {
    while (this.launching.size) await Bun.sleep(5);
  }

  // ---- queue -------------------------------------------------------------

  startQueued(): void {
    if (this.draining) return;
    const { maxWorkers } = this.store.settings();
    let active = LIVE.reduce((n, lane) => n + this.store.cardsIn(lane).length, 0);
    for (const card of this.store.cardsIn("todo")) {
      if (active >= maxWorkers) break;
      active++;
      const started = this.store.updateCard(card.id, { lane: "working", attention: null, resume_lane: null, worked: 0 });
      this.store.log(card.id, "starting worker");
      this.opts.notify?.({ kind: "started", card: started });
      this.background(card.id, () => this.startWorker(card.id));
    }
  }

  private async startWorker(id: number): Promise<void> {
    let card = this.store.card(id)!;
    const project = this.store.project(card.project_id)!;
    const role = resolveRole(this.store.settings(), "worker", project, card);
    if (!project.base) card = this.store.updateCard(id, { worktree: 0 });
    if (card.worktree) {
      const branch = `hb/${card.id}-${slug(card.title)}`;
      const wt = await this.herdr.worktreeCreate(project.path, branch, project.base);
      card = this.store.updateCard(id, { branch, cwd: wt.path, workspace_id: wt.workspaceId, worker_pane: wt.paneId });
      this.store.log(id, `worktree ${wt.path} on ${branch}`);
    } else {
      const tab = await this.herdr.tabIn(project.path, `hb-${card.id}`);
      card = this.store.updateCard(id, { cwd: project.path, workspace_id: tab.workspaceId, tab_id: tab.tabId, worker_pane: tab.paneId });
    }
    const brief = this.writeBrief(`cards/${id}/worker.md`, workerBrief(card, project, this.attachmentFiles(id)));
    await this.launch(card.worker_pane!, launchCommand(role), `HB_CARD=${id} HB_ROLE=worker`, `hb-${id}-worker`, brief);
    this.store.log(id, `worker started in ${card.worker_pane}: ${describeRole(role)}`);
  }

  private async startReviewer(id: number): Promise<void> {
    const card = this.store.card(id)!;
    const project = this.store.project(card.project_id)!;
    const role = resolveRole(this.store.settings(), "reviewer", project, card);
    const pane = await this.herdr.split(card.worker_pane!, card.cwd!);
    this.store.updateCard(id, { reviewer_pane: pane, worked: 0 });
    const brief = this.writeBrief(`cards/${id}/reviewer.md`, reviewerBrief(card, project, this.attachmentFiles(id)));
    await this.launch(pane, launchCommand(role), `HB_CARD=${id} HB_ROLE=reviewer`, `hb-${id}-reviewer`, brief);
    this.store.log(id, `reviewer started in ${pane}: ${describeRole(role)}`);
  }

  /**
   * Types the profile command into a shell pane, waits for herdr to see the
   * agent settle, then names it and hands it the brief. Folder trust for a new
   * worktree is answered here: registering the project is the trust decision.
   */
  private async launch(pane: string, command: string, env: string, name: string, briefPath: string): Promise<void> {
    // The brief lives outside the worktree; without this every non-bypass mode
    // asks permission just to read it.
    const briefDir = briefPath.slice(0, briefPath.lastIndexOf("/"));
    await this.herdr.run(pane, `${env} HB_URL=${this.opts.url} ${command} --add-dir ${shellQuote(briefDir)}`);
    const deadline = Date.now() + this.launchTimeoutMs;
    let settled = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(this.pollMs);
      const status = (await this.herdr.agents()).get(pane);
      if (status === "blocked" && (await this.herdr.read(pane)).includes(TRUST_PROMPT)) {
        await this.herdr.sendKeys(pane, ["down", "enter"]);
        settled = 0;
        continue;
      }
      settled = status === "idle" || status === "done" ? settled + 1 : 0;
      if (settled >= 2) {
        await this.herdr.rename(pane, name);
        await this.herdr.prompt(name, `Read ${briefPath} and follow it.`);
        return;
      }
    }
    throw new Error(`agent in ${pane} did not become ready within ${this.launchTimeoutMs / 1000}s`);
  }

  private background(id: number, work: () => Promise<void>): void {
    this.launching.add(id);
    work()
      .catch((e) => {
        // The card may have been deleted while it was launching.
        const card = this.store.card(id);
        if (card) this.needsYou(card, `Launch failed: ${e.message}`, null);
      })
      .finally(() => this.launching.delete(id));
  }

  // ---- agent state -------------------------------------------------------

  async sync(): Promise<void> {
    const agents = await this.herdr.agents();
    this.statuses = agents;
    const watched = this.store.cards().filter((c) => LIVE.includes(c.lane) || (c.lane === "needs_you" && c.resume_lane));
    for (const card of watched) {
      if (this.launching.has(card.id)) continue;
      const pane = this.activePane(card);
      if (!pane) continue;
      this.syncCard(card, agents.get(pane));
    }
  }

  private syncCard(card: Card, status: AgentStatus | undefined): void {
    if (status === undefined) {
      this.needsYou(card, "The agent exited.", null);
    } else if (card.lane === "needs_you") {
      // `worked` here means "settled since entering needs_you": working before
      // that is the tail of the turn that asked, not the agent being answered.
      if (status === "working" && card.worked) {
        this.store.updateCard(card.id, { lane: card.resume_lane!, attention: null, resume_lane: null, worked: 1 });
        this.store.log(card.id, `agent working again, back to ${card.resume_lane}`);
      } else if (status !== "working" && !card.worked) {
        this.store.updateCard(card.id, { worked: 1 });
      }
    } else if (status === "blocked") {
      this.needsYou(card, "The agent is waiting for a permission or an answer in herdr.", card.lane);
      this.store.updateCard(card.id, { worked: 1 });
    } else if (status === "working") {
      if (!card.worked) this.store.updateCard(card.id, { worked: 1 });
    } else if ((status === "idle" || status === "done") && card.worked) {
      const cmd = card.lane === "review" ? "hb review" : "hb done";
      this.needsYou(card, `The agent stopped without running \`${cmd}\`.`, card.lane);
    }
  }

  activePane(card: Card): string | null {
    const lane = card.lane === "needs_you" ? card.resume_lane : card.lane;
    return lane === "review" ? card.reviewer_pane : card.worker_pane;
  }

  private needsYou(card: Card, attention: string, resume: Lane | null): void {
    const updated = this.store.updateCard(card.id, { lane: "needs_you", attention, resume_lane: resume, worked: 0 });
    this.store.log(card.id, `needs you: ${attention}`);
    this.opts.notify?.({ kind: "needs_you", card: updated });
  }

  // ---- reports from agents (hb CLI) --------------------------------------

  done(id: number, summary: string): Card {
    const card = this.expect(id, "working");
    this.store.updateCard(id, { summary, attention: null, resume_lane: null });
    this.store.endRun(id, summary);
    this.store.log(id, `worker done: ${summary}`);
    if (!card.review) return this.toReady(id);
    this.store.updateCard(id, { lane: "review" });
    this.background(id, () => this.startReviewer(id));
    return this.store.card(id)!;
  }

  async review(id: number, approve: boolean, notes = ""): Promise<Card> {
    const card = this.expect(id, "review");
    if (card.reviewer_pane) await this.herdr.closePane(card.reviewer_pane).catch(() => {});
    this.store.updateCard(id, { reviewer_pane: null, attention: null, resume_lane: null });
    if (approve) {
      this.store.log(id, `review approved${notes ? `: ${notes}` : ""}`);
      return this.toReady(id);
    }
    const round = card.round + 1;
    const { maxRounds } = this.store.settings();
    this.store.log(id, `review round ${round}: changes requested\n${notes}`);
    if (round > maxRounds) {
      const updated = this.store.updateCard(id, { round });
      this.needsYou(updated, `Review still failing after ${maxRounds} rounds:\n${notes}`, "working");
      return this.store.card(id)!;
    }
    this.store.updateCard(id, { lane: "working", round, worked: 0 });
    await this.herdr.prompt(card.worker_pane!, feedbackPrompt(notes, round, maxRounds));
    return this.store.card(id)!;
  }

  ask(id: number, question: string): Card {
    const card = this.store.card(id);
    if (!card) throw new Error(`no card #${id}`);
    // From Ready the agent is offering something: the answer puts it back to work.
    this.needsYou(card, question, LIVE.includes(card.lane) ? card.lane : card.lane === "ready" ? "working" : card.resume_lane);
    return this.store.card(id)!;
  }

  /** Lane check that also accepts a needs_you card that will return to `lane`. */
  private expect(id: number, lane: Lane): Card {
    const card = this.store.card(id);
    if (!card) throw new Error(`no card #${id}`);
    if (card.lane !== lane && !(card.lane === "needs_you" && card.resume_lane === lane)) {
      throw new Error(`card #${id} is in ${card.lane}, not ${lane}`);
    }
    return card;
  }

  private toReady(id: number): Card {
    this.store.log(id, "ready");
    const card = this.store.updateCard(id, { lane: "ready", attention: null, resume_lane: null });
    this.opts.notify?.({ kind: "ready", card });
    return card;
  }

  // ---- human actions -----------------------------------------------------

  /**
   * Sends the human's message to the running agent. A Ready card is still open
   * (the agent and its worktree stay until Finish), so a reply there puts it
   * back to working: the agent's next `hb done` needs that lane.
   */
  async reply(id: number, text: string, uploads?: unknown, review?: boolean): Promise<void> {
    const card = this.store.card(id);
    if (!card) throw new Error(`no card #${id}`);
    const pane = this.activePane(card);
    if (!pane) throw new Error(`card #${id} has no running agent`);
    if (!text.trim() && !(Array.isArray(uploads) && uploads.length)) throw new Error("write a message or attach a file");
    if (card.lane === "ready") {
      const { maxWorkers } = this.store.settings();
      if (LIVE.reduce((n, lane) => n + this.store.cardsIn(lane).length, 0) >= maxWorkers) {
        throw new Error(`all ${maxWorkers} worker slots are busy; reply once one finishes`);
      }
    }
    const files = saveAttachments(this.opts.home, id, uploads);
    const message = files.length ? `${text}\n\nAttached files:\n${files.map((f) => `- ${f}`).join("\n")}`.trim() : text;
    await this.herdr.prompt(pane, message);
    this.store.log(id, `you: ${message}`);
    if (card.lane === "ready") {
      // The human decides whether this follow-up needs another reviewer round.
      this.store.updateCard(id, { lane: "working", attention: null, resume_lane: null, worked: 0, ...(review === undefined ? {} : { review: Number(review) }) });
      this.store.log(id, `reply sent from ready, back to working${review === undefined ? "" : review ? " (reviewed again)" : " (no review)"}`);
    }
  }

  async focus(id: number): Promise<void> {
    const card = this.store.card(id);
    const pane = card && (this.activePane(card) ?? card.worker_pane);
    if (!pane) throw new Error(`card #${id} has no agent`);
    await this.herdr.focus(pane);
  }

  /** backlog ⇄ todo for cards that never started; anything → done finishes it. */
  async move(id: number, lane: Lane): Promise<Card> {
    const card = this.store.card(id);
    if (!card) throw new Error(`no card #${id}`);
    if (lane === "done") return this.finish(id);
    if ((lane === "backlog" || lane === "todo") && !card.workspace_id) {
      this.store.log(id, `moved to ${lane}`);
      return this.store.updateCard(id, { lane, attention: null, resume_lane: null });
    }
    throw new Error(`card #${id} can't be moved from ${card.lane} to ${lane}`);
  }

  /** Removes the worktree (herdr refuses if it has uncommitted work) or closes the tab. */
  async finish(id: number): Promise<Card> {
    const card = this.store.card(id);
    if (!card) throw new Error(`no card #${id}`);
    if (card.worktree && card.workspace_id) await this.herdr.worktreeRemove(card.workspace_id);
    else if (card.tab_id) await this.herdr.closeTab(card.tab_id).catch(() => {});
    this.store.log(id, "finished");
    await this.cleanUp(card);
    const done = this.store.updateCard(id, {
      lane: "done",
      attention: null,
      resume_lane: null,
      workspace_id: null,
      tab_id: null,
      worker_pane: null,
      reviewer_pane: null,
    });
    this.opts.notify?.({ kind: "done", card: done });
    return done;
  }

  private async cleanUp(card: Card): Promise<void> {
    try {
      const project = this.store.project(card.project_id);
      if (!project || !this.opts.cleanup) return;
      for (const line of await this.opts.cleanup(card, project)) this.store.log(card.id, line);
    } catch (e) {
      this.store.log(card.id, `cleanup failed: ${(e as Error).message}`);
    }
  }

  // ---- orchestrator ------------------------------------------------------

  async startOrchestrator(projectId: number): Promise<void> {
    const project = this.store.project(projectId);
    if (!project) throw new Error(`no project #${projectId}`);
    if (project.orch_pane && (await this.herdr.agents()).has(project.orch_pane)) {
      await this.herdr.focus(project.orch_pane);
      return;
    }
    const role = resolveRole(this.store.settings(), "orchestrator", project);
    const tab = await this.herdr.tabIn(project.path, "hb-orchestrator");
    this.store.updateProject(projectId, { orch_pane: tab.paneId });
    const brief = this.writeBrief(`projects/${projectId}/orchestrator.md`, orchestratorBrief(project));
    const env = `HB_PROJECT=${shellQuote(project.name)} HB_ROLE=orchestrator`;
    await this.launch(tab.paneId, launchCommand(role), env, `hb-orch-${slug(project.name, 20)}`, brief);
    await this.herdr.focus(tab.paneId);
  }

  async sayToOrchestrator(projectId: number, text: string): Promise<void> {
    const pane = this.store.project(projectId)?.orch_pane;
    if (!pane || !(await this.herdr.agents()).has(pane)) throw new Error("orchestrator is not running; start it first");
    await this.herdr.prompt(pane, text);
  }

  // ---- automations -------------------------------------------------------

  async runAutomations(now: number): Promise<void> {
    for (const a of this.store.automations()) {
      if (!a.enabled) continue;
      try {
        if (isDue(parseTrigger(a.trigger), Math.max(a.last_run_at, a.created_at), now)) await this.fire(a, now);
      } catch (e) {
        console.error(`automation ${a.name}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * An automation keeps one card. A fire while that card sits in Ready with its
   * agent alive sends the brief to the same agent again. If the agent is gone,
   * the card is finished and a new one made. A card still in progress, or one
   * that can't be finished, makes the fire skip, never queue.
   */
  async fire(a: Automation, now = Date.now()): Promise<Card | null> {
    if (this.firing.has(a.id)) return null;
    this.firing.add(a.id);
    try {
      return await this.fireOnce(a, now);
    } finally {
      this.firing.delete(a.id);
    }
  }

  private async fireOnce(a: Automation, now: number): Promise<Card | null> {
    const previous = this.store.automation(a.id)!.last_run_at;
    this.store.updateAutomation(a.id, { last_run_at: now });
    const open = this.store.cards().find((c) => c.automation_id === a.id && c.lane !== "done");
    if (open && open.lane !== "ready") {
      this.store.log(open.id, `automation ${a.name} fired while this card is open; skipped`);
      return null;
    }
    const status = open?.worker_pane ? (await this.herdr.agents()).get(open.worker_pane) : undefined;
    if (open && status) return this.rerun(a, open, now, status, previous);
    if (open) {
      try {
        await this.finish(open.id);
      } catch (e) {
        const reason = (e as Error).message;
        this.store.log(open.id, `automation ${a.name} could not finish this card, so it skipped: ${reason}`);
        // Written once, so "blocked since" keeps the first failure instead of the latest run.
        if (!open.attention) this.store.updateCard(open.id, { attention: `Automation "${a.title}" is paused until this card is finished: ${reason}` });
        return null;
      }
    }
    const card = this.store.addCard({
      project_id: a.project_id,
      title: a.title,
      brief: a.brief,
      lane: "todo",
      review: a.review,
      worktree: a.worktree,
      worker: a.worker,
      reviewer: a.reviewer,
      automation_id: a.id,
    });
    this.store.addRun(a.id, card.id, now);
    return card;
  }

  /** The next run on the agent that did the last one: same card, worktree and conversation. */
  private async rerun(a: Automation, card: Card, now: number, status: AgentStatus, previous: number): Promise<Card | null> {
    // Not dropped: the run stays due, so the next tick tries again. Logged once, not every tick.
    const wait = (why: string) => {
      this.store.updateAutomation(a.id, { last_run_at: previous });
      const text = `automation ${a.name} is due, waiting: ${why}`;
      if (this.store.events(card.id).at(-1)?.text !== text) this.store.log(card.id, text);
      return null;
    };
    // Typing into a turn in progress or a permission prompt would answer it for you.
    if (status !== "idle" && status !== "done") return wait(`the agent is ${status}`);
    const { maxWorkers } = this.store.settings();
    if (LIVE.reduce((n, lane) => n + this.store.cardsIn(lane).length, 0) >= maxWorkers) return wait(`all ${maxWorkers} worker slots are busy`);
    const project = this.store.project(card.project_id)!;
    // Edits to the automation since the last run apply to this one (the worker profile can't: the agent stays).
    const updated = this.store.updateCard(card.id, { title: a.title, brief: a.brief, review: a.review, reviewer: a.reviewer, round: 0 });
    const brief = this.writeBrief(`cards/${card.id}/worker.md`, workerBrief(updated, project, this.attachmentFiles(card.id)));
    // A card from before runs were recorded: its first run becomes run 1.
    if (!this.store.runCount(card.id)) this.store.addRun(a.id, card.id, card.created_at, card.summary);
    const run = this.store.runCount(card.id) + 1;
    await this.herdr.prompt(card.worker_pane!, `Automation "${a.title}" is due again (run ${run}). Read ${brief} again and do this run, then report with \`hb done\` as before.`);
    this.store.addRun(a.id, card.id, now);
    this.store.log(card.id, `run ${run}: brief sent to the same agent`);
    const working = this.store.updateCard(card.id, { lane: "working", attention: null, resume_lane: null, summary: null, worked: 0 });
    this.opts.notify?.({ kind: "started", card: working });
    return working;
  }

  /** Why this automation can't start a new run: its open card waits on a human. */
  blocked(a: Automation): { card_id: number; reason: string; since: number } | null {
    const c = this.store.cards().find((x) => x.automation_id === a.id && x.lane !== "done");
    if (!c) return null;
    if (c.lane === "needs_you") return { card_id: c.id, reason: c.attention || "waiting for you", since: c.updated_at };
    if (c.lane === "ready" && c.attention) return { card_id: c.id, reason: c.attention, since: c.updated_at };
    return null;
  }

  private attachmentFiles(id: number): string[] {
    return listAttachments(this.opts.home, id).map((a) => `${attachmentDir(this.opts.home, id)}/${a.name}`);
  }

  private writeBrief(rel: string, text: string): string {
    const path = `${this.opts.home}/${rel}`;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
}

export function slug(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "card"
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
