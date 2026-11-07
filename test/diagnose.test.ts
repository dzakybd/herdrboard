import { expect, test } from "bun:test";
import { explainStop } from "../src/diagnose.ts";

const c = { profile: "cc1", report: "hb done" };

// Copied from a real cc1 pane that ran out of its 5-hour window.
const LIMIT = `❯ Read /Users/me/.herdrboard/cards/1/worker.md and follow it.
  ⎿  You've hit your 5-hour limit · resets 12:10pm (Asia/Jakarta)
⏺ Usage limit reached · continuing automatically at 12:10pm · esc to cancel
✻ Cogitated for 9s · done 11:29 AM`;

test("a usage limit names the profile, the limit and when it resets", () => {
  expect(explainStop("stopped", LIMIT, c)).toBe(
    "cc1 hit its 5-hour usage limit (resets 12:10pm). Claude Code carries on by itself then, and the card goes back to work. To stop it instead, Finish the card.",
  );
});

test("an API error is quoted", () => {
  expect(explainStop("stopped", "⏺ Working on it\n  ⎿  API Error: 529 Overloaded", c)).toBe(
    'cc1 got an error from the model API: "API Error: 529 Overloaded". Reply to the card to have it try again.',
  );
});

test("a logged-out profile says so", () => {
  expect(explainStop("stopped", "  ⎿  Invalid API key · Please run /login", c)).toStartWith("cc1 is not logged in.");
});

test("error words in the code the agent shows are not taken for its own state", () => {
  const screen = "  throw new ApiError('API Error: retry later')\n⏺ I fixed the retry loop.";
  expect(explainStop("stopped", screen, c)).toBe('The agent stopped without running `hb done`. Its last message: "I fixed the retry loop." Reply to tell it what to do next.');
});

test("blocked quotes the question it is asking", () => {
  const screen = "⏺ Bash(rm -rf build)\n│ Do you want to proceed?\n❯ 1. Yes\n  2. No";
  expect(explainStop("blocked", screen, c)).toBe('The agent is waiting for your answer in herdr: "Do you want to proceed?"');
});

test("exit quotes the last line left in the pane", () => {
  expect(explainStop("exited", "zsh: command not found: cc9\nme@mac ~ % ", c)).toBe('The agent (cc1) exited. Last line in its pane: "zsh: command not found: cc9"');
});
