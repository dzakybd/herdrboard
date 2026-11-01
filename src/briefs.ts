import type { Card, Project } from "./db.ts";

export function attachmentsSection(files: string[]): string {
  if (!files.length) return "";
  return `\n## Attachments\n\nThe human attached these files. Open them as needed (images can be read directly):\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n`;
}

export function workerBrief(card: Card, project: Project, files: string[] = []): string {
  const where = card.branch
    ? `You are in a git worktree on branch \`${card.branch}\` (base \`${project.base}\`). Commit your work on this branch. Do not push unless the task says so.`
    : !project.base
      ? `You are in \`${project.path}\`, a folder of repositories, not a repository itself. Work out which repositories this task needs. For each one, make your own worktree on a new branch from its default branch: \`git -C <repo> worktree add ${project.path}/.hb-worktrees/${card.id}/<repo> -b hb/${card.id}-<short-slug>\`. Work and commit there, never in the repository's own checkout. Do not push unless the task says so. List each repository and branch in your \`hb done\` summary.`
      : `You are in the project's main checkout. There is no dedicated branch for this card.`;
  return `# Card #${card.id}: ${card.title}

You are a worker agent managed by herdrboard (project "${project.name}").

## Task

${card.brief || card.title}
${attachmentsSection(files)}
## How to work

- ${where}
- When the task is finished, run: \`hb done --summary "<result>"\`. The human reads this on the board and it is all that stays after your session closes, so report what you did and found in full. Markdown is rendered: use headings, lists and links where they help.
- If you need a decision from the human, run \`hb ask "<question>"\` and wait for the answer.
- After \`hb done\` the human can still reply with a follow-up or an extra request (and may attach files, whose paths come with the message). Do the work, then run \`hb done --summary "..."\` again. If you want to offer something (a next step, a cleanup, a choice), run \`hb ask "<offer>"\` instead of acting on your own.
- Your card id is in \`$HB_CARD\`; \`hb\` picks it up on its own.
`;
}

export function reviewerBrief(card: Card, project: Project, files: string[] = []): string {
  const scope = card.branch
    ? `Review the changes with \`git diff ${project.base}...HEAD\` and \`git status\` (uncommitted work counts as not done).`
    : !project.base
      ? `The worker's worktrees are under \`${project.path}/.hb-worktrees/${card.id}/\`, one per repository. In each, review with \`git diff <default branch>...HEAD\` and \`git status\` (uncommitted work counts as not done).`
      : `There is no branch for this card. Review the worker's result in the working tree and its summary below.`;
  return `# Review card #${card.id}: ${card.title}

You are a reviewer agent managed by herdrboard (project "${project.name}"). A worker says this task is done. Check that it really is. Do not edit any files.

## Task the worker was given

${card.brief || card.title}
${attachmentsSection(files)}
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

You are the orchestrator for this project, managed by herdrboard. The human will tell you what they want. Turn it into well-scoped cards that worker agents will do in parallel, each in its own git worktree${project.base ? "" : ` (this project is a folder of repositories, so workers pick the repositories and make the worktrees themselves)`}. You do not write the code yourself.

Use the \`hb\` CLI (the project is picked from \`$HB_PROJECT\`):

- \`hb card add "<title>" --brief "<full self-contained brief>"\` puts a card in Todo; a worker starts on it right away.
  Add \`--backlog\` to park it, \`--no-review\` to skip the reviewer, \`--no-worktree\` to run in the main checkout, \`--attach <file>\` (repeatable) to give the worker images or files.
- \`hb card list\` and \`hb card show <id>\` show progress; \`hb card move <id> <lane>\` moves a card between backlog and todo.
- \`hb automation add --title "<t>" --trigger "every 30m" --brief "<b>"\` adds a scheduled card.

Each brief must stand on its own: the worker sees only the brief, not this conversation. Keep cards independent so they can run in parallel. Say what you created when you are done.

Reply "ready" now and wait for the human's first request.
`;
}

export function feedbackPrompt(notes: string, round: number, max: number): string {
  return `The reviewer requested changes (round ${round} of ${max}):\n\n${notes}\n\nFix them, commit, then run \`hb done --summary "..."\` again.`;
}
