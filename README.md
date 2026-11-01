# herdrboard

A kanban board and automation layer for coding agents that run in [herdr](https://herdr.dev). Each agent is an ordinary, interactive Claude Code session in a herdr pane, so you can watch it and talk to it in Ovis or the herdr TUI. The board tells them what to do and keeps track of where each task is.

- **Card pipeline.** A card in Todo gets its own git worktree (a herdr workspace) and a worker agent. When the worker runs `hb done`, a reviewer agent opens in a split pane. If the reviewer asks for changes, the feedback goes back to the worker, up to 2 rounds; after that the card goes to *Needs you*. You can turn review off per card or per project.
- **Profiles per role.** Orchestrator, worker, and reviewer each use a profile (a command typed into the pane, such as your `cc1`/`cc2`/`ccd` zsh functions, picked up from `~/.zshrc` on first run) plus an optional **model**, **effort** (`low` … `max`), and **permission mode** (default `bypassPermissions`). They are appended as `--model`, `--effort` and `--permission-mode`. Set defaults in Settings and override them per project, per card, or per automation; each field falls back to the next level on its own.
- **Orchestrator.** One agent per project, running in the main checkout. Tell it what you want (in herdr or from the board) and it turns that into cards with `hb card add`.
- **Automations.** `every 30m`, `daily 09:00`, `weekdays 09:00`, or `weekly mon 09:00`. Each fire creates a card in Todo. A previous card in Ready is finished automatically; one still in progress makes the fire skip.
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

On Linux the same script installs a systemd user unit (`~/.config/systemd/user/dev.dzaky.herdrboard.service`). Run `sudo loginctl enable-linger $USER` once so it survives logout.

```sh
systemctl --user status dev.dzaky.herdrboard
systemctl --user restart dev.dzaky.herdrboard
journalctl --user -u dev.dzaky.herdrboard   # or ~/.herdrboard/serve.log
```

### Updating while agents are running

Pull or edit the code, then run `hb restart`. Agents live in herdr, not in the board, so they keep running. On shutdown the board stops taking requests, lets any worker or reviewer that is mid-launch finish (up to 60s), then exits. An agent's `hb done` or `hb ask` made during the restart waits up to 60s for the board to come back instead of failing. `./scripts/install.sh` also applies the longer stop timeout (`ExitTimeOut` / `TimeoutStopSec`) to an existing service.

The full guide, with diagrams, is built into the board at **http://127.0.0.1:7420/docs** (the book icon in the top bar).

## Phone and other devices

The board listens on `0.0.0.0:7420` (`HB_HOST` to change). Because agents can run with bypassed permissions, access from any other device needs a token. Run `hb url` on the Mac and open the link once on your phone: it sets a cookie and redirects to the board. The token lives in `~/.herdrboard/token` (mode 600); delete the file and restart to rotate it. This Mac (the CLI and agents) needs no token.

This is plain HTTP, so only open it on a network you trust, or put it behind Tailscale.

Add a project with **Projects → Browse** (a folder picker that marks git repositories), or `hb project add <repo>`,, check the profiles under **Settings**, then create a card.

A project can also be a folder that holds several repositories. Cards there run in that folder, and the worker picks the repositories and makes its own worktrees under `.hb-worktrees/<card>/`. Finish removes each of those worktrees that has no uncommitted changes (their branches are kept) and reports any it leaves.

Adding a project means you trust it. Claude Code asks "do you trust this folder?" for every new worktree, and herdrboard answers yes. It answers that prompt and no other.

## CLI

`hb help` lists everything. Agents use:

```sh
hb done --summary "what I did"           # worker
hb review --approve                      # reviewer
hb review --changes "1. … 2. …"
hb ask "Which provider should I use?"    # any agent
hb card add "Title" --brief "…"          # orchestrator
```

`hb card add` and `hb automation add` also take `--model`, `--effort` and `--mode` for the worker.

In a mode other than bypass, Claude Code asks before running `hb done` and similar commands; the card shows in *Needs you* until you approve in herdr.

Agents are started with `HB_CARD`, `HB_ROLE`, `HB_URL` (and `HB_PROJECT` for the orchestrator) in their environment, so these commands need no ids.

## Move to another machine

`hb export board.json` (or **Settings → Export**) saves projects, automations, card history and settings, without the access token. Cards still in progress are left out, because their agents and worktrees can't move.

On the new machine, install herdrboard and clone your repositories, then run `hb import board.json --dry-run` (or **Settings → Import**). It checks each path, git root and base branch, plus triggers and profiles, and changes nothing. Fix what it reports with `--path PROJECT=/new/path` or `--skip PROJECT`, then run it without `--dry-run`. Import is all or nothing, and running it again adds nothing new.

Pending cards arrive in Backlog, so no agent starts. Automations keep their on/off state and count their schedule from the import. Projects and automations already on the machine stay as they are, and settings are only replaced on an empty board; otherwise only missing profiles are added. A profile is a command typed into a shell, so read the warnings for any new ones. Stop the old board afterwards, or both will run the automations.

## Agent skill

Teach any coding agent to use the board:

```sh
npx skills add dzakybd/herdrboard
```

The skill (`skills/herdrboard/SKILL.md`) covers filing cards, watching progress, the orchestrator, automations, and the `hb done` / `hb review` / `hb ask` reports.

## How it talks to herdr

Only through the `herdr` CLI: `worktree create/remove`, `tab create`, `pane run/split/close/read`, and `agent list/rename/prompt/focus/send-keys`. An agent is launched by typing `HB_CARD=… <profile command>` into a fresh shell pane. The board then waits for herdr to report the agent as idle, names it `hb-<card>-<role>`, and prompts it with the path of a brief file (`~/.herdrboard/cards/<id>/worker.md`). Lane changes come from `hb` reports plus herdr's agent status, polled every 3 s.

**Finish** (dragging a card to Done) removes the card's worktree; herdr refuses if there is uncommitted work. The branch is kept: merging or opening a PR is up to you, or put it in the brief. The exception is an automation's card whose branch has no commits beyond the base: that empty local branch is deleted, so frequent runs don't pile up branches.

## Files

| Path | What |
| --- | --- |
| `~/.herdrboard/herdrboard.db` | SQLite: projects, cards, events, automations, settings |
| `~/.herdrboard/cards/<id>/` | brief files handed to agents |
| `~/.herdrboard/serve.log` | service log |

Set `HB_HOME` / `HB_PORT` to run a second instance, e.g. for testing.
