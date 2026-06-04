# agent-skills changelog

## 0.4.3

### Patch Changes

- 2a577d7: Add the `agent-hub` pi harness — an `agent-team` dispatcher with an embedded `coms` P2P layer, plus its recipe family and reusable peer manifest.

  The dispatcher is now itself a coms peer: it carries the `coms_*` tools, `/handoff <peer>` to delegate a self-contained brief, `/coms` for the message log, peer-as-subagent dispatch, and `--name/--purpose/--project/--color/--explicit` identity flags, with graceful degradation when the coms endpoint can't bind. New `just` recipes:

  - `just hub` — the dispatcher with embedded coms (accepts the coms identity flags).
  - `just hub-solo` — the hub without the coms layer (fixed specialists + research only, lighter).
  - `just peer <persona> [name] [model]` — a single reusable coms peer (coms + compact-and-continue + a persona under `.pi/agents/`).
  - `just team-up <team>` / `just team-up-dry <team>` — spawn every peer of a team from `.pi/agents/peers.yaml` into tiled tmux panes (dry-run prints the resolved commands without launching).

  Adds `.pi/agents/peers.yaml` (reusable peers grouped into named teams), starter `architect` and `releaser` peer personas, `scripts/team-up.ts`, and an `agent-hub` row in the pi-extensions catalog.

- a8f959b: Expose `ask_user` in the Pi dispatcher harness tool surface when the companion package is available.
- c466ede: **guided-workspace-setup:** render every interactive table compact so it fits a standard terminal width in the `pi-ask-user` widget.

  The Step 6 install menus, the Step 9 plan summary, and the Step 4/5 doctor-findings table all forced horizontal overflow — long `installed · …` state strings on every menu row, a separate `Rec` column, full-sentence purposes, and a Step 9 mega-table with `Target paths` + `Notes` columns and an `Artifacts` cell listing every skill name. Users had to zoom out, which re-rendered the widget and caused flicker. Now:

  - **Step 6 menus** use short status tokens (`ok`/`upd`/`mod`/`cflt`/`gone`/`new`/`pkg`/`—`/`brk`) with a one-line legend, fold the `★` recommendation mark into the item name (no `Rec` column), and cap purpose/group cells.
  - **Step 9 confirmation** renders as compact action-grouped lines (Add / Refresh / Remove / Keep-count / Records / Method) instead of a wide table; target paths are omitted and the "Changes since" delta is shown as short per-change bullets rather than one long line.
  - **Doctor-findings table** uses short issue/fix phrases.

- c466ede: Remove retired pi harnesses and related just shortcuts.

  The `minimal`, `tilldone`, `tool-counter`, and `tool-counter-widget` harness directories are no longer shipped, and the matching `just ext-*` launch recipes have been removed. The `primecc`, `primepi`, and `test` just recipes were also removed. Pi setup docs, the harness catalog, and guided setup menus now list only the remaining supported harnesses.

## 0.4.2

### Patch Changes

- **CLI `update`:** re-install the `/setup-agent-skills` command so it is always present after an update.

  `guided-workspace-setup` removes the installer command at the end of a run by default (Step 10b / `cleanupInstaller`), so a workspace that had completed setup once was left with no `/setup-agent-skills` command — yet `update` still told users to run it. `update` now re-bootstraps the installer artifacts for the workspace's agent before printing the hand-off.

  The agent/method are recovered from the init-time bootstrap marker; if that was cleaned up too, detection now prefers the workspace's own `.claude/`/`.opencode/`/`.pi/` dirs over the ambient agent env var (new `preferWorkspaceHints` option on `detectAgent`), so a pi workspace no longer mis-resolves to claude-code when `update` is run from inside a Claude Code shell. Supports `--agent`, `--method`, and `--dry-run`.

## 0.4.1

### Changes

- **guided-workspace-setup:** collapse install menu from 19 screens into 7 grouped multi-selects (4 shared: Skills, Agent personas, Commands/prompts, References & Hooks; 3 pi-only: pi extensions & runtime skills, pi harnesses, External pi packages). Multi-type groups carry a `Group` sub-category column (lifecycle phase, writeable/read-only, harness category, etc.) so sub-sections stay readable on a single screen.
- **guided-workspace-setup (pi):** add Step 5b — bootstrap `pi-ask-user` project-scoped before the install menu, then ask the user to reload and re-run so the rest of setup uses a native multi-select widget.
- **agent-team harness:** make the dispatcher a true orchestrator — gate `pi-ask-user`'s `ask_user` into its tool surface, add configurable user-facing language, and route specialist questions back through the dispatcher via an `ASK_USER:` bubble-up protocol. This functionality now lives in the consolidated [agent-hub README](.pi/harnesses/agent-hub/README.md).
- **pi package:** publish agent-skills as a first-class pi package and bundle `pi-ask-user` so pi installs expose the `ask_user` tool and `ask-user` skill without a separate install.

## 0.3.3

### Patch Changes

- Ship `scripts/coms-net-server.ts` in the npm tarball.

  The `coms-net` pi harness shells out to this hub server at runtime
  (`.pi/harnesses/coms-net/index.ts` and its README both reference it),
  but the file was missing from the `files` allowlist — so users who
  installed via `npx @chankov/agent-skills init` and tried to start the
  coms-net harness got `MODULE_NOT_FOUND`.

  Added `scripts/*.ts` to the allowlist (the `.test.mjs` siblings stay
  out — they're dev-only), and added `scripts/` to `snapshot-version.js`
  so future `.versions/<x.y.z>/` snapshots include it for the version-
  aware three-way diff.

## 0.3.1

### Patch Changes

- Fix: skill resolved the wrong source root on dev machines that have a
  local clone of `agent-skills`.

  Before this fix, `init` bootstrapped the `guided-workspace-setup` SKILL.md
  into the workspace at `.pi/skills/...` (or `.claude/skills/...`). When the
  slash command later loaded the skill, the skill's Step 2 used a "two levels
  above this file" heuristic to find the source package — but that path
  resolved to the _workspace_, not the npm package. The skill then fell back
  to scanning the user's filesystem with `find`, which on a dev machine
  matched the user's own git clone of `agent-skills`. The clone could be
  on a different version, mid-edit, or contain experimental skills the user
  hadn't intended to install.

  The fix:

  1. **`init` now writes `.ai/.agent-skills-bootstrap.json`** containing the
     absolute path to the source package (the npm cache path, the global
     install path, or the symlinked clone — whatever `init` was run from).
  2. **The skill reads this marker first** when resolving the source root.
     The marker is authoritative; it overrides any older source reference in
     the install record.
  3. **The skill never scans the filesystem.** If the marker is missing or
     stale (path no longer exists), it asks the user for the path explicitly.
     `find /media/...`, `find ~/repos/...`, etc. are explicitly listed as red
     flags in the skill's anti-pattern table.
  4. **The marker file is removed** by Step 10b cleanup alongside the
     slash commands.

  Affects only the skill's behaviour after `init` — no user-facing CLI
  changes. Workspaces upgraded from 0.2.x get the marker on their next
  `npx @chankov/agent-skills init`.

## 0.3.0

### Minor Changes

- **Rename installer slash commands** + **auto-remove them after setup**.

  The bootstrap commands are now namespaced so they don't collide with anything
  in your workspace, and they get cleaned up automatically once `/setup-agent-skills`
  finishes — leaving your agent's slash-command list as clean as before you ran
  `init`.

  ### What changed

  - `/setup` → `/setup-agent-skills`
  - `/doctor` → `/doctor-agent-skills`
  - `/as-setup` → `/as-setup-agent-skills` (OpenCode)
  - `/as-doctor` → `/as-doctor-agent-skills` (OpenCode)
  - `guided-workspace-setup` SKILL.md still installs to `.{claude,pi,opencode}/skills/`
    during bootstrap and is removed alongside the slash commands

  ### Cleanup behaviour (default)

  After `/setup-agent-skills` completes its install pass, the skill deletes the
  bootstrap files (slash commands + skill body) from the workspace. The Step 9
  confirmation states this explicitly and accepts `keep` as the opt-out. When
  opted out, `keep-installer: true` is recorded in
  `.ai/agent-skills-setup.md#workspace-summary`.

  Re-run `npx @chankov/agent-skills init` whenever you need
  `/setup-agent-skills` back — it's a one-line re-bootstrap.

  ### Migration for users on 0.2.x

  `npx @chankov/agent-skills@latest init` automatically detects and removes the
  pre-rename `setup.md`/`doctor.md`/`as-*.md` files from the workspace before
  writing the new names. No manual cleanup required.

  ### New CLI subcommand

  - `npx @chankov/agent-skills cleanup-installer --agent <agent>` — removes the
    bootstrap files standalone. The skill calls this at end of apply; you can
    also invoke it by hand. Honors `--dry-run`.

### Patch Changes

- Fix: `npx @chankov/agent-skills init` now bootstraps the installer artifacts
  (`/setup`, `/doctor`, and the `guided-workspace-setup` skill) into the
  workspace before printing the hand-off.

  In 0.1.0 / 0.2.0, `init` printed _"Open your coding agent and run /setup"_ —
  but `/setup` is itself a slash-command file that needed to exist in
  `.claude/commands/`, `.pi/prompts/`, or `.opencode/commands/`. Fresh
  workspaces didn't have it, so the agent had no idea what `/setup` was and
  the hand-off silently no-op'd.

  What `init` now writes (per chosen agent, to the workspace):

  | Agent         | Files                                                                                                                                                                                                                                      |
  | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `claude-code` | `.claude/commands/setup.md`, `.claude/commands/doctor.md`, `.claude/skills/guided-workspace-setup/SKILL.md`                                                                                                                                |
  | `pi`          | `.pi/prompts/setup.md`, `.pi/prompts/doctor.md`, `.pi/skills/guided-workspace-setup/SKILL.md`                                                                                                                                              |
  | `opencode`    | `.opencode/commands/as-setup.md`, `.opencode/commands/as-doctor.md`, `.opencode/skills/guided-workspace-setup/SKILL.md` (+ printed note about adding the global AGENTS.md reference; project-local skill discovery in OpenCode is limited) |

  The rest of the catalogue (the user-facing skills, personas, references,
  hooks, pi extensions) is unchanged — those are still chosen interactively
  inside `/setup`, as designed. The CLI only drops the installer plumbing.

  Bootstrap files are always refreshed on re-run (they are scaffolding, not
  user data). `--method symlink` against an unstable source path
  (`~/.npm/_npx/...`) prints a warning recommending `--method copy` or a
  global install.

## 0.2.0

### Minor Changes

- 7f2be04: Initial npm release. Ships the full skills catalog, agent personas, slash
  commands, and pi extensions as an installable package, with a thin CLI
  (`npx agent-skills init`) that hands off to the LLM-driven
  `guided-workspace-setup` skill. Adds version-aware updates: the install record
  now embeds the package version, and re-running `/setup` after a version bump
  surfaces a per-artifact three-way diff (source@recorded vs installed copy vs
  source@current) before touching any file.
- Add three layered update-notification paths so users are told when a newer
  version is published, without having to remember to check:

  1. **CLI update-notifier** (`bin/lib/update-notifier.js`) — every
     `npx @chankov/agent-skills <cmd>` reads a shared 24h cache; if the cached
     latest exceeds the running CLI version, a banner prints to stderr. Stale
     caches are refreshed by a detached background process so the current run
     is never blocked.
  2. **`check-update` CLI subcommand** — standalone entry point used by hooks
     and extensions; blocks on a single registry fetch (2s timeout) and prints
     the banner to stdout if outdated. Always exits 0.
  3. **Claude Code session-start hook** (`hooks/session-start.sh`) — extended
     to call `check-update` with a 3s wall-clock cap and inject the banner into
     the session context so Claude can surface it on its first turn.
  4. **pi extension** (`.pi/extensions/agent-skills-update-check/`) — fires on
     the first `agent_start` event of each pi session, reads the same shared
     cache, emits `ctx.ui.notify` if outdated. Offered as a `★`-recommended
     pick in install-menu Group 10.

  All three share the cache at `$XDG_CACHE_HOME/agent-skills/latest-version.json`
  so the registry is hit at most once per 24h window across all runtimes.

  Opt-out via any of `AGENT_SKILLS_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`,
  or `CI=true`.

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries below 0.1.0
are pre-npm history captured in git.

The file is rolled forward by [changesets](https://github.com/changesets/changesets) —
do not edit it by hand. Add a `.changeset/<name>.md` file describing your
change and let `changeset version` aggregate it.

## Unreleased

Pending changesets in `.changeset/` will roll into the next release.
