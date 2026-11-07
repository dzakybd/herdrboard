/**
 * Why an agent left its lane, in words the person can act on. herdr only says
 * idle / blocked / gone; the reason is on the agent's screen, so this reads
 * the messages Claude Code prints there. Anything unrecognised falls back to
 * quoting the last thing the agent said.
 */
export type Stop = "stopped" | "blocked" | "exited";

export interface StopContext {
  profile: string; // the launcher, e.g. cc1
  report: string; // the command the agent should have run: `hb done` or `hb review`
}

const MAX_QUOTE = 200;

const quote = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t}"`;
};

/** Claude Code's own failure messages, most specific first. */
const KNOWN: { match: RegExp; say: (m: RegExpMatchArray, c: StopContext) => string }[] = [
  {
    match: /hit your ([\w-]+(?: [\w-]+)?) limit[^\n]*?resets ([^\n(·]+)/i,
    say: (m, c) => `${c.profile} hit its ${m[1]} usage limit (resets ${m[2]!.trim()}). Claude Code carries on by itself then, and the card goes back to work. To stop it instead, Finish the card.`,
  },
  {
    match: /usage limit reached/i,
    say: (_m, c) => `${c.profile} hit its usage limit. Claude Code carries on by itself once it resets, and the card goes back to work. To stop it instead, Finish the card.`,
  },
  {
    match: /credit balance is too low|insufficient (?:credit|quota|balance)/i,
    say: (_m, c) => `${c.profile} is out of credit. Top it up, or Finish the card and run it with another profile.`,
  },
  {
    match: /please run \/login|invalid api key|oauth token (?:has )?expired|not logged in/i,
    say: (_m, c) => `${c.profile} is not logged in. Log in from its pane in herdr, then reply to the card to carry on.`,
  },
  {
    match: /API Error[^\n]*/i,
    say: (m, c) => `${c.profile} got an error from the model API: ${quote(m[0])}. Reply to the card to have it try again.`,
  },
];

/** What the agent said last: Claude Code marks its output lines with ⏺ and ⎿. */
function lastWords(screen: string): string | null {
  const lines = screen.split("\n").filter((l) => /^\s*[⏺⎿]/.test(l));
  const line = lines.at(-1)?.replace(/^\s*[⏺⎿]\s*/, "");
  return line ? line : null;
}

export function explainStop(stop: Stop, screen: string, c: StopContext): string {
  // Only Claude Code's own status lines: an agent can have "API Error" in the code it is showing.
  const status = screen.split("\n").filter((l) => /^\s*[⏺⎿⚠]/.test(l)).join("\n");
  for (const k of KNOWN) {
    const m = status.match(k.match);
    if (m) return k.say(m, c);
  }
  if (stop === "blocked") {
    const question = screen.split("\n").filter((l) => /\?\s*$/.test(l)).at(-1);
    return question
      ? `The agent is waiting for your answer in herdr: ${quote(question.replace(/^[\s│❯>]+/, ""))}`
      : "The agent is waiting for a permission or an answer in herdr.";
  }
  if (stop === "exited") {
    // Skip the shell prompt the pane is left at; the line before it says what went wrong.
    const last = screen.split("\n").map((l) => l.trim()).filter((l) => l && !/^.{0,40}[$%#❯➜]$/.test(l)).at(-1);
    return last ? `The agent (${c.profile}) exited. Last line in its pane: ${quote(last)}` : `The agent (${c.profile}) exited and its pane is gone.`;
  }
  const words = lastWords(screen);
  return `The agent stopped without running \`${c.report}\`.${words ? ` Its last message: ${quote(words)}` : ""} Reply to tell it what to do next.`;
}
