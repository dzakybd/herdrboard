import type { Automation, Card, CardEvent, Project } from "./db.ts";
import type { AgentStatus } from "./herdr.ts";

/** What Telegram may do on the board: the same operations the web UI and `hb` use. */
export interface Board {
  reply(cardId: number, text: string): Promise<void>;
  projects(): Project[];
  cards(): (Card & { agent_status: AgentStatus | null })[];
  events(cardId: number): CardEvent[];
  addCard(project: string, title: string, brief: string): Card;
  finish(cardId: number): Promise<Card>;
  runAutomation(name: string): Promise<Card>;
}

export interface Context {
  board: Board;
  args: string;
  /** The card whose topic the command was sent in, if any. */
  topicCard: number | null;
  /** Posts a progress line before a slow command finishes. */
  say(text: string): Promise<void>;
}

interface Command {
  usage: string;
  help: string;
  run(ctx: Context): Promise<string>;
}

const label = (lane: string) => lane.replace("_", " ");

export const COMMANDS: Record<string, Command> = {
  new: {
    usage: "/new [project] <title>",
    help: "create a card; lines after the first are its brief",
    async run({ board, args }) {
      const [first = "", ...rest] = args.split("\n");
      const words = first.trim().split(/\s+/).filter(Boolean);
      const projects = board.projects();
      const named = projects.find((p) => p.name === words[0]);
      let project: Project | undefined;
      if (named && words.length > 1) {
        project = named;
        words.shift();
      } else if (projects.length === 1) {
        project = projects[0];
      }
      if (!project) {
        if (!projects.length) throw new Error("no projects yet: add one on the board or with `hb project add <path>`");
        throw new Error(`start with the project: ${projects.map((p) => p.name).join(", ")}\n/new <project> <title>`);
      }
      if (!words.length) throw new Error("usage: /new [project] <title>, then the brief on the next lines");
      const card = board.addCard(project.name, words.join(" "), rest.join("\n").trim());
      return `Created #${card.id} in ${project.name} (${label(card.lane)}). Its topic opens when the agent starts.`;
    },
  },
  cards: {
    usage: "/cards",
    help: "open cards, their lane and what the agent is doing",
    async run({ board }) {
      const open = board.cards().filter((c) => c.lane !== "done");
      if (!open.length) return "No open cards.";
      return open
        .map((c) => {
          const agent = c.agent_status ? `, agent ${c.agent_status}` : "";
          const why = c.lane === "needs_you" && c.attention ? `\n   ${c.attention.split("\n")[0]}` : "";
          return `#${c.id} ${label(c.lane)}${agent}: ${c.title}${why}`;
        })
        .join("\n");
    },
  },
  status: {
    usage: "/status [id]",
    help: "a card's lane, what it waits on, summary and recent activity (in a topic: that card)",
    async run({ board, args, topicCard }) {
      const card = pick(board, args, topicCard, "status");
      const lines = [`#${card.id} ${card.title}`, `Lane: ${label(card.lane)}${card.agent_status ? ` (agent ${card.agent_status})` : ""}`];
      if (card.branch) lines.push(`Branch: ${card.branch}`);
      if (card.attention) lines.push("", `Waiting on you: ${card.attention}`);
      if (card.summary) lines.push("", `Summary: ${card.summary}`);
      const recent = board.events(card.id).slice(-5);
      if (recent.length) lines.push("", "Recent:", ...recent.map((e) => `- ${new Date(e.at).toTimeString().slice(0, 5)} ${e.text.split("\n")[0]!.slice(0, 200)}`));
      return lines.join("\n");
    },
  },
  finish: {
    usage: "/finish [id]",
    help: "finish a card like Finish on the board (in a topic: that card)",
    async run({ board, args, topicCard, say }) {
      const card = pick(board, args, topicCard, "finish");
      if (card.lane === "done") throw new Error(`#${card.id} is already finished`);
      // Said first: finishing closes this topic.
      await say(`Finishing #${card.id}…`);
      await board.finish(card.id);
      return `Finished #${card.id}.`;
    },
  },
  projects: {
    usage: "/projects",
    help: "registered projects",
    async run({ board }) {
      const projects = board.projects();
      return projects.length ? projects.map((p) => `${p.name}: ${p.path}`).join("\n") : "No projects yet.";
    },
  },
  run: {
    usage: "/run <automation>",
    help: "fire an automation now",
    async run({ board, args }) {
      const name = args.trim();
      if (!name) throw new Error("usage: /run <automation> (names are on the board's Automations page)");
      const card = await board.runAutomation(name);
      return `Run started on #${card.id}.`;
    },
  },
  help: {
    usage: "/help",
    help: "this list",
    async run() {
      return [...Object.values(COMMANDS).map((c) => `${c.usage}: ${c.help}`), "", "In a card's topic, plain text goes to its agent."].join("\n");
    },
  },
};

/** The card named in `args`, else the topic's card. Strict, since /finish can't be undone. */
function pick(board: Board, args: string, topicCard: number | null, command: string) {
  const given = args.trim();
  if (given && !/^#?\d+$/.test(given)) throw new Error(`not a card id: ${given}`);
  const id = given ? Number(given.replace(/^#/, "")) : topicCard;
  if (!id) throw new Error(`which card? /${command} <id>, or send it in the card's topic`);
  const card = board.cards().find((c) => c.id === id);
  if (!card) throw new Error(`no card #${id}`);
  return card;
}

/** Telegram's command menu (setMyCommands). */
export const MENU = Object.entries(COMMANDS).map(([command, c]) => ({ command, description: c.help.slice(0, 256) }));
