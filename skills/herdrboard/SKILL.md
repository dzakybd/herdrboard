---
name: herdrboard
description: "Control herdrboard, a kanban board that runs coding agents as interactive sessions in herdr. Use when the user asks to put work on the board, create or check cards, start the orchestrator, add a scheduled automation, or when you were started by herdrboard ($HB_CARD or $HB_PROJECT is set) and need to report done, review, or ask the human."
---

# herdrboard

herdrboard is a local kanban board (`http://127.0.0.1:7420`) whose cards are worked on by coding agents running in [herdr](https://herdr.dev) panes. Each card in Todo gets its own git worktree and a worker agent. When the worker reports done, a reviewer agent checks it (optional per card). You drive it with the `hb` CLI.

Lanes: `backlog → todo → working → review → needs_you → ready → done`.

## Check it is available

```bash
hb card list
```

If `hb` is missing, or it says herdrboard is not running, tell the user to install it. Do not install it yourself:

```bash
git clone https://github.com/dzakybd/herdrboard && cd herdrboard && ./scripts/install.sh
```

## If you were started by herdrboard

Your environment has `HB_ROLE` (`worker`, `reviewer` or `orchestrator`), plus `HB_CARD` for the worker and reviewer roles or `HB_PROJECT` for the orchestrator. Your brief file says what to do. These commands find your card on their own:

| Role | When | Command |
| --- | --- | --- |
| worker | task finished and committed | `hb done --summary "<one line>"` |
| reviewer | work is correct | `hb review --approve` |
| reviewer | work needs fixes | `hb review --changes "<numbered, concrete fixes>"` |
| any | you need a human decision | `hb ask "<question>"`, then wait for the reply |

Always end a worker turn with `hb done`, and a reviewer turn with `hb review`. Otherwise the card is flagged "stopped without reporting".

## Putting work on the board

```bash
hb project list                                  # registered repositories
hb project add <repo-root>                       # only when the user asks; it means they trust the repo
hb card add "<title>" --brief "<full brief>"     # goes to Todo and starts right away
hb card add "<title>" --brief-file brief.md --backlog   # parked; `hb card move <id> todo` starts it
```

Options for `card add`:
- `--project <name>`: defaults to `$HB_PROJECT`, then the project containing the current folder.
- `--no-review`: skip the reviewer.
- `--no-worktree`: run in the main checkout (no branch).
- `--worker <profile>` / `--reviewer <profile>`: profile names come from the board's Settings.
- `--model <m>`, `--effort low|medium|high|xhigh|max`, `--mode bypassPermissions|acceptEdits|auto|manual|dontAsk|plan`: apply to the worker; unset fields use the board's defaults. Use a stronger model or higher effort only for hard cards. Any mode other than `bypassPermissions` makes the worker stop at permission prompts, which show the card in `needs_you`.

The worker sees only the brief. Make each brief self-contained: goal, relevant files, constraints, and how to verify. Keep cards independent so they can run in parallel.

## Watching progress

```bash
hb card list [--project P] [--lane needs_you]
hb card show <id>          # brief, summary, branch, full event log
```

Cards in `needs_you` are waiting for the human. Report them to the user. Do not answer on the user's behalf.

## Orchestrator and automations

```bash
hb orch start [project]            # start or focus the project's orchestrator agent in herdr
hb orch say [project] "<request>"  # send it a message
hb automation list
hb automation add --name <n> --trigger "every 30m" --title "<t>" --brief "<b>" [--no-worktree] [--no-review]
hb automation run <name>           # fire now
```

Trigger forms: `every 30m|2h|1d`, `daily HH:MM`, `weekly mon HH:MM`. Each fire creates a Todo card. It is skipped while the automation's previous card is still open.

## Phone access

`hb url` prints a link with the access token for opening the board on another device. Give it only to the user, never paste it into a card, a commit, or a shared channel.

## Rules

- Do not move a started card back to backlog or todo. Moving a card to `done` removes its worktree (Finish). Do it only when the user asks.
- Do not run `hb project add` on a repository the user has not asked for. Registering it makes herdrboard answer Claude Code's folder-trust prompt there.
- `hb help` prints the full command list.
