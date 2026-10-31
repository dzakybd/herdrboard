import type { Card, Project } from "./db.ts";

export function workerBrief(card: Card, project: Project): string {
  const where = card.branch
    ? `You are in a git worktree on branch \`${card.branch}\` (base \`${project.base}\`). Commit your work on this branch. Do not push unless the task says so.`
    : `You are in the project's main checkout. There is no dedicated branch for this card.`;
  return `# Card #${card.id}: ${card.title}

You are a worker agent managed by herdrboard (project "${project.name}").

## Task

${card.brief || card.title}

## How to work

- ${where}
- When the task is finished, run: \`hb done --summary "<one line of what you did>"\`
- If you need a decision from the human, run \`hb ask "<question>"\` and wait for the answer.
- Your card id is in \`$HB_CARD\`; \`hb\` picks it up on its own.
`;
}

export function reviewerBrief(card: Card, project: Project): string {
  const scope = card.branch
    ? `Review the changes with \`git diff ${project.base}...HEAD\` and \`git status\` (uncommitted work counts as not done).`
    : `There is no branch for this card. Review the worker's result in the working tree and its summary below.`;
  return `# Review card #${card.id}: ${card.title}

You are a reviewer agent managed by herdrboard (project "${project.name}"). A worker says this task is done. Check that it really is. Do not edit any files.

## Task the worker was given

${card.brief || card.title}

## Worker's summary

${card.summary ?? "(none)"}

## What to do

- ${scope}
- Check that the task is fully done, correct, and has no obvious bugs. Run the project's tests if it has them.
- If it is good, run: \`hb review --approve\`
- If not, run: \`hb review --changes "<concrete, numbered list of what to fix>"\`
`;
}

export function orchestratorBrief(project: Project): string {
  return `# Orchestrator for "${project.name}"

You are the orchestrator for this project, managed by herdrboard. The human will tell you what they want. Turn it into well-scoped cards that worker agents will do in parallel, each in its own git worktree. You do not write the code yourself.

Use the \`hb\` CLI (the project is picked from \`$HB_PROJECT\`):

- \`hb card add "<title>" --brief "<full self-contained brief>"\` puts a card in Todo; a worker starts on it right away.
  Add \`--backlog\` to park it, \`--no-review\` to skip the reviewer, \`--no-worktree\` to run in the main checkout.
- \`hb card list\` and \`hb card show <id>\` show progress; \`hb card move <id> <lane>\` moves a card between backlog and todo.
- \`hb automation add --name <n> --trigger "every 30m" --title "<t>" --brief "<b>"\` adds a scheduled card.

Each brief must stand on its own: the worker sees only the brief, not this conversation. Keep cards independent so they can run in parallel. Say what you created when you are done.

Reply "ready" now and wait for the human's first request.
`;
}

export function feedbackPrompt(notes: string, round: number, max: number): string {
  return `The reviewer requested changes (round ${round} of ${max}):\n\n${notes}\n\nFix them, commit, then run \`hb done --summary "..."\` again.`;
}
