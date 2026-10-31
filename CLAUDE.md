# herdrboard

## Project context

### Stack
- Language and version: TypeScript on Bun 1.4
- Framework(s): none (Bun.serve, bun:sqlite, vanilla HTML/JS)
- Package manager: bun
- Runtime / deployment target: local macOS, launchd agent `dev.dzaky.herdrboard` on 127.0.0.1:7420

### Commands
- Install: `./scripts/install.sh` (bun install, bun link, launchd)
- Build: none
- Test (all): `bun test`
- Test (single file): `bun test test/pipeline.test.ts`
- Lint: none
- Typecheck: `bunx tsc --noEmit`
- Run locally: `HB_HOME=/tmp/hb HB_PORT=7421 bun src/cli.ts serve` (keeps the real service and state untouched)
- Restart the service after code changes: `launchctl kickstart -k gui/$(id -u)/dev.dzaky.herdrboard`

### Layout
- Source lives in: `src/` (server, pipeline state machine, herdr CLI wrapper, db, scheduler, profiles, briefs, cli) and `web/index.html`
- Tests live in: `test/` (pipeline tests use an in-memory `FakeHerdr`)
- Do not modify: nothing generated

### Conventions specific to this repo
- Naming: lanes are snake_case strings (`needs_you`); DB columns are snake_case.
- Import style: relative imports with `.ts` extensions.
- Error handling pattern: throw `Error` with a user-readable message; the server turns it into `400 {error}`, and the CLI and UI show it as is.
- Testing pattern and framework: `bun:test`; drive `Pipeline` through `FakeHerdr`, assert on store state.

### Forbidden
- Talking to herdr through anything but `src/herdr.ts` (the `Herdr` interface keeps the pipeline testable).
- Closing herdr workspaces, tabs, or panes that herdrboard did not create, or running `herdr server stop`.
- Answering agent prompts other than Claude Code's folder-trust prompt automatically.
- `curl`/inline fetch in Bash is blocked by a hook here: check the API with `hb …` instead.

## Project Learnings

- herdr reports a freshly typed `cc2` as `idle` before Claude Code has drawn its UI. Wait for two settled polls, and handle the folder-trust prompt (`blocked`) first.
- After `hb ask`, the agent is still `working` while it finishes that turn. A needs_you card may only return to its lane after the agent has settled once (`worked` flag).
- `herdr worktree remove` also closes the workspace and its agents. `herdr worktree create` creates a primary workspace for the repo root if none exists.
- `HB_CARD=1 cc2` passes env through zsh functions, and the cc functions' `env -u …` keeps it.
