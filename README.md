# herdrboard

A kanban board and automation layer for coding agents that run in [herdr](https://herdr.dev). Each agent is an ordinary, interactive Claude Code session in a herdr pane, so you can watch it and talk to it in Ovis or the herdr TUI. The board tells them what to do and keeps track of where each task is.

- **Card pipeline.** A card in Todo gets its own git worktree (a herdr workspace) and a worker agent. When the worker runs `hb done`, a reviewer agent opens in a split pane. If the reviewer asks for changes, the feedback goes back to the worker, up to 2 rounds; after that the card goes to *Needs you*. You can turn review off per card or per project.
- **Profiles per role.** Orchestrator, worker, and reviewer each use a profile: a command typed into the pane, such as your `cc1`/`cc2`/`ccd` zsh functions. Profiles are picked up from `~/.zshrc` on first run. You can override them per project and per card.
- **Orchestrator.** One agent per project, running in the main checkout. Tell it what you want (in herdr or from the board) and it turns that into cards with `hb card add`.
- **Automations.** `every 30m`, `daily 09:00`, or `weekly mon 09:00`. Each fire creates a card in Todo. If the automation's previous card is still open, the fire is skipped.
- **Needs you.** A card lands here when the agent is waiting on a permission prompt, runs `hb ask`, stops without reporting, or exits. Reply from the card, or answer in the agent's terminal. Either way, the card goes back to its lane once the agent is working again.

```
Backlog → Todo → Working → Review → Ready → Done
                    ↑   ↘      ↓ changes (≤ 2 rounds)
                    └──── Needs you
```

## Install

Requires `bun`, `herdr` (with its server running), and `git`.

```sh
git clone https://github.com/dzakybd/herdrboard && cd herdrboard
./scripts/install.sh      # bun link (puts `hb` on PATH) + launchd agent dev.dzaky.herdrboard
open http://127.0.0.1:7420
```

Add a project with **Projects** (or `hb project add <repo>`), check the profiles under **Settings**, then create a card.

Adding a repository means you trust it. Claude Code asks "do you trust this folder?" for every new worktree, and herdrboard answers yes. It answers that prompt and no other.

## CLI

`hb help` lists everything. Agents use:

```sh
hb done --summary "what I did"           # worker
hb review --approve                      # reviewer
hb review --changes "1. … 2. …"
hb ask "Which provider should I use?"    # any agent
hb card add "Title" --brief "…"          # orchestrator
```

Agents are started with `HB_CARD`, `HB_ROLE`, `HB_URL` (and `HB_PROJECT` for the orchestrator) in their environment, so these commands need no ids.

## Agent skill

Teach any coding agent to use the board:

```sh
npx skills add dzakybd/herdrboard
```

The skill (`skills/herdrboard/SKILL.md`) covers filing cards, watching progress, the orchestrator, automations, and the `hb done` / `hb review` / `hb ask` reports.

## How it talks to herdr

Only through the `herdr` CLI: `worktree create/remove`, `tab create`, `pane run/split/close/read`, and `agent list/rename/prompt/focus/send-keys`. An agent is launched by typing `HB_CARD=… <profile command>` into a fresh shell pane. The board then waits for herdr to report the agent as idle, names it `hb-<card>-<role>`, and prompts it with the path of a brief file (`~/.herdrboard/cards/<id>/worker.md`). Lane changes come from `hb` reports plus herdr's agent status, polled every 3 s.

**Finish** (dragging a card to Done) removes the card's worktree; herdr refuses if there is uncommitted work. The branch is kept: merging or opening a PR is up to you, or put it in the brief.

## Files

| Path | What |
| --- | --- |
| `~/.herdrboard/herdrboard.db` | SQLite: projects, cards, events, automations, settings |
| `~/.herdrboard/cards/<id>/` | brief files handed to agents |
| `~/.herdrboard/serve.log` | service log |

Set `HB_HOME` / `HB_PORT` to run a second instance, e.g. for testing.
