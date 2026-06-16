# agent-skills changelog

## 1.1.0

### Minor Changes

- agent-hub: per-persona thinking levels. Each persona's `thinking:` frontmatter sets its pi `--thinking` reasoning effort, switchable at runtime with `/agent-model-thinking <persona>` (off · minimal · low · medium · high · xhigh) and overridable per project via a `thinking.<persona>:` key under `## agent-team`. The level renders as a short badge after the model in the dashboard cards and the compact below-editor view (e.g. `gpt-5.5 (xh)`), and the compact view now shows the model + badge per running agent. Default levels are tiered by role (architect/security/planner xhigh; builder/reviewers/orchestrator high; test/bowser medium; researcher/releaser low; documenter minimal).
- `/orchestrate` command for claude-code (`/orchestrate`) and opencode (`/as-orchestrate`): the main session / primary agent becomes an orchestrator that drives a config-defined team of installed subagents — default team `planner` + `builder` (no reviewer) — routing them as a **runtime roster, not a fixed pipeline** (skip planning when a plan exists, re-run `researcher` anytime, loop back to `planner`), and handling the `PLAN_FILE:` / `NEEDS_RESEARCH:` handoff markers. Named teams live in a per-agent `orchestrate-teams.yaml` (mirroring pi's `.pi/agents/teams.yaml`) and switch at runtime with `/orchestrate <team> "<task>"`. pi is excluded — it orchestrates via the `agent-hub` harness. `guided-workspace-setup` now offers `/orchestrate` `★`-recommended (with its team-config companion) for claude-code + opencode, drives the claude-code install menu via `AskUserQuestion` questionnaires (quick-path + ≤4-option chunks), and gates the lifecycle hooks to claude-code only.

## 1.0.0

### Major Changes

- 0bee132: Retire the `scout` persona and remove the `pi-pi` harness

  - `agents/scout.md` is gone. Use `spawn_research` (agent-hub) or the `planner` persona for read-only recon; install records and setup docs no longer offer `scout`.
  - The `pi-pi` meta-agent harness (`.pi/harnesses/pi-pi/`), its expert personas (`agents/pi-pi/`), the `ext-pi-pi` just recipe, the `pi-pi` team in `.pi/agents/teams.yaml`, and the `docs/pi-specs/pi-pi.md` spec are removed. `FIRECRAWL_API_KEY` is no longer used by anything in this repo.
  - The doctor scan no longer walks `agents/pi-pi/` or `.pi/agents/pi-pi/`; existing installs with `scout` or `pi-pi` symlinks will surface them as broken links to repair or delete on the next doctor run.

### Minor Changes

- 75b1a7f: Rewrite the `btw` pi extension around an in-process sub-session and a live modal

  `/btw <task>` no longer spawns a child `pi` process and waits to report back as a
  single expanded chat card. It now forks the current session into an **in-process
  sub-session** (`createAgentSession`, default coding tools, no extension runtime) and
  opens a **top-center modal** that streams the sub-session's transcript live and
  accepts follow-ups — mid-run follow-ups steer the active turn, idle ones start a fresh
  turn.

  - New `Alt+Shift+B` shortcut (and bare `/btw`) reopens the modal on the last-viewed thread.
  - `Esc` hides the modal while the task keeps running; completion only toasts and never
    steals focus. `←/→` switches between concurrent threads; `↑/↓` scrolls; `Ctrl+C`
    copies the selected entry.
  - Each finished turn writes the full answer to `.pi/btw-sessions/<id>.result.md` and
    drops a **compact** card (✓/✗ + task + elapsed + first lines + artifact path) into
    the main transcript at idle — replacing the old expanded-by-default card.

  The token-thinness invariants are unchanged: command-only surface, no model-callable
  tool, and the `on("context")` filter still keeps every btw card out of the main
  agent's LLM context.

- 0bee132: agent-hub: delegate sub-roles rolled out to five more personas, on an OpenAI-first model ladder

  - `planner`, `plan-reviewer`, `builder`, `test-engineer`, and `security-auditor` now declare `subagents:` sub-roles and a "Delegation pre-pass" prompt section, so each can fan out read-only helpers mid-turn via the `delegate` tool (within the existing budgets: 4 children per dispatch, depth 1, parallel children read-only).
    - `planner` — `scout` + `rules` (spark) map the codebase and project rules in parallel before drafting; `risk` (gpt-5.4) optionally challenges the draft breakdown.
    - `plan-reviewer` — `feasibility` (gpt-5.4) verifies plan claims against the codebase; `deps` (spark) checks dependency ordering and file overlap.
    - `security-auditor` — solo `recon` (spark) maps the attack surface first, then `input-sweep` (gpt-5.4) and `secrets-sweep` (spark) fan out; exploit reasoning stays with the parent.
    - `builder` — `recon` (spark) maps call sites before edits; `verifier` (spark) is the single `allow_write: true` child that runs the test suite after them. Implementation is never delegated.
    - `test-engineer` — `coverage-scout` + `conventions` (spark) inventory coverage gaps and test patterns; test writing is never delegated.
  - Model ladder is OpenAI-first: `openai-codex/gpt-5.3-codex-spark` for recon/mechanical sweeps, `openai-codex/gpt-5.4` for analysis sweeps, `openai-codex/gpt-5.5` (xhigh) parents reserved for synthesis and verdicts.
  - `code-reviewer` sub-roles rerouted accordingly: `quality`/`perf` move from sonnet to `gpt-5.4`, `docs` from haiku to spark; `gpt-5.4` and spark join its candidate list. The parent stays on opus 4.8.
  - `plan-reviewer`'s parent model switches from opus 4.8 to `openai-codex/gpt-5.5` with `thinking: xhigh`; candidates are `gpt-5.4` and spark.
  - The personas gaining sub-roles also gain `models:` candidate lists (`gpt-5.4`, spark), so `/agent-model <persona>` and `/agent-model <persona>.<role>` have switch targets.
  - `.pi/agents/model-profiles.yaml`: `max` and `budget` profiles now cover `planner`, `plan-reviewer`, `security-auditor`, and `test-engineer`; `budget` moves `code-reviewer` from sonnet to `gpt-5.4`.

- 412273e: Reorganize agent-hub team sets around SDD gates: `default` gains `test-engineer` as the verify gate and drops the always-on `security-auditor` and `bowser`; `debug` is rebuilt around the Prove-It pattern (test-engineer, builder, code-reviewer); `frontend` gains a `code-reviewer` merge gate; new `security` (conditional audit cycle), `hotfix` (minimal builder + reviewer pair), and `release` (releaser + documenter — releaser was previously unreachable via dispatch) teams.
- 0bee132: Personas are now installable for every supported coding agent, with deterministic per-agent transformation:

  - New `agent-skills transform-persona` CLI subcommand (backed by `bin/lib/transform-persona.js`, under `node --test` coverage) generates per-agent subagent files from the canonical `agents/*.md`: Claude Code gets `.claude/agents/<name>.md` with tools/model translated (`read→Read`, `find/ls→Glob`, `claude-opus-*→opus`, …), OpenCode gets `.opencode/agent/<name>.md` with `mode: subagent` + tool denials, pi gets the canonical file unchanged. Agent-hub-only frontmatter (`models`, `thinking`, `delegate_depth`, `subagents`, `kind`, `skills`) never leaks into transformed output.
  - `/setup-agent-skills` now offers the **full persona roster** per agent (was a hardcoded 7): all 14 for pi; 11 for claude-code/opencode (`bowser`, `orchestrator`, `orchestrator-careful` are pi-only). Transformed installs are always generated copies — even in symlink mode — recorded with `transformed: true` and diffed against generated output on re-runs.
  - README: full 14-persona table with access level, primary-skill mapping, and per-agent availability, plus new sections on how personas connect to skills and how to compose them into subagent teams (pi agent-hub teams/peers, Claude Code subagents, OpenCode `@`-mentions).
  - **Removed** support surfaces for Cursor, Gemini CLI, Windsurf, GitHub Copilot, and Codex: their `docs/*-setup.md` guides and README install sections are gone, and the doctor no longer scans `.codex/agents/`, `.gemini/agents/`, or `.github/agents/` (it now also scans `.opencode/agent/`, and repairs broken persona links under `.claude/agents/` / `.opencode/agent(s)/` by regenerating transformed copies instead of re-symlinking the raw source). If you followed one of the deleted guides, the skills remain plain Markdown and still work — but the repo no longer documents or maintains those paths.

- 0bee132: agent-hub: sub-role model switching, project rules, and a review preflight

  - `/agent-model <persona>.<role>` switches a delegate sub-role's model among the role's declared default plus the parent persona's candidate list; applied via the delegate config on the persona's next dispatch (nested children inherit it). `/models` profiles still never touch sub-roles.
  - New `rules:` key under `## agent-team` in `.ai/agent-skills-overrides.md`: comma-separated repo-relative folders of project rule files, each searched recursively through all subfolders. The harness injects a "Project rules" block into every dispatched specialist; missing folders warn at session start.
  - The planner and code-reviewer personas resolve the `rules:` entry, validate their subject against the discovered rules, and pass the relevant rules on — cited in plan acceptance criteria (planner) or handed to the right delegate sub-reviewer (code-reviewer).
  - code-reviewer gains a `preflight` sub-role (default `openai-codex/gpt-5.3-codex-spark`) that runs as the mandatory first delegate call: it studies the rules and the files under review and returns a summary that drives the rest of the fan-out.
  - code-reviewer's `security` delegate sub-role is removed — deep security review is owned by the separate `security-auditor` persona, which the reviewer now recommends dispatching when it spots deeper risk.

## 0.4.5

### Patch Changes

- agent-hub: mid-turn nested subagents via an injected `delegate` tool. A persona
  that declares a `subagents:` frontmatter map (role → model + optional tools
  cap) gets a real `delegate(role, instruction, context?, allow_write?)` tool in
  its spawned process, so a top-tier specialist can fan out scoped sub-tasks to
  cheaper models mid-turn. Budgets are readable refusals with conservative limits:
  max delegate depth is clamped to 1 and each dispatch has a tree-wide budget of 4
  children; depth-0 children do not receive delegate tooling/config. Children are
  read-only unless a single live child gets `allow_write: true` (role-level
  `tools:` cap wins and fails closed if it leaves no available tools); children
  report through a delegation event file the hub tails into nested grid rows with
  per-child `/zoom`, token rollups on the parent card, and a session-wide
  delegated-spend counter; `/agents-kill` SIGTERMs the specialist's whole process
  group so the delegation tree dies with it. Spawn + JSON-stream parsing extracted
  into a shared `spawnPiAgent()` helper (`spawn.ts`) used by dispatch, research
  helpers, and `delegate.ts`; all harness TypeScript support files are included in
  the npm package. Per-project `subagents.<persona>.<role>:` /
  `delegate-depth.<persona>:` override keys under `## agent-team`. Pilot persona:
  code-reviewer (quality/security/perf on sonnet, docs on haiku, delegation
  pre-pass protocol).
- agent-hub: runtime persona model switching. Personas declare allowed switch
  targets via a frontmatter `models:` list; `/agent-model <persona>` picks from
  the declared candidates (session-lifetime, applies on next dispatch), and
  `/models [profile]` applies a named team profile from
  `.pi/agents/model-profiles.yaml` (validated at session start against each
  persona's candidates — invalid profiles are dropped whole). Per-project
  `model.<persona>:` / `models.<persona>:` keys under `## agent-team` in
  `.ai/agent-skills-overrides.md` override the default model and candidate list.
  Pilot candidate lists added to the code-reviewer and builder personas.
- Planner persona upgrade + mandatory damage-control pairing for agent-hub.

  - `agents/planner.md` rewritten: scoped `write` (plan document + provided assets, only inside the override-resolved `plan-dir`), `bash` restricted to read-only git inspection (`git status` / `git diff --stat` / `git diff` / `git log`), explicit use of the `planning-and-task-breakdown` skill when present, an orient-first process, and a dispatcher contract (`PLAN_FILE:` / `NEEDS_RESEARCH:` markers, ASK_USER for ambiguity).
  - `agent-hub` now shows a session-start warning when the `damage-control` harness cannot be resolved (specialist/research subprocesses would spawn unguarded).
  - `agent-hub` auto-research pipe: specialists can pause with `NEEDS_RESEARCH: <question>` lines (mirror of `ASK_USER:`); the hub intercepts them in code, fans out read-only research helpers, writes findings to `.pi/agent-sessions/findings/*.md`, and resumes the specialist's session with the file paths — the dispatcher LLM sees only a one-line notice, keeping its context clean of raw findings. Budgets: 4 questions per pause, 2 pauses per dispatch.
  - `guided-workspace-setup` enforces a mandatory pairing: installing or keeping `agent-hub` auto-installs/keeps `damage-control`, which cannot be deselected while `agent-hub` stays; `planner` moved to the _writeable_ persona group (scoped writes).
  - Personas mapped to repo skills (conditional "if the skill exists in the repo" hooks): `builder` → incremental-implementation, `code-reviewer` → code-review-and-quality, `test-engineer` → test-driven-development (+ explicit `tools:` incl. write/bash — the missing key previously defaulted to read-only under agent-hub), `security-auditor` → security-and-hardening, `documenter` → documentation-and-adrs, `plan-reviewer` → planning-and-task-breakdown (checklist as review criteria), `architect` → api-and-interface-design + ADRs, `releaser` → git-workflow-and-versioning + shipping-and-launch. Dispatched specialists also carry the `NEEDS_RESEARCH` pause hook; peers and recon personas deliberately do not. See `docs/plans/personas/PLAN-persona-skill-mapping.md`.

## 0.4.4

### Patch Changes

- 81f86fd: Add a `btw` always-on pi extension that adds a single `/btw <task>` prompt command, modeled on Claude Code's `/btw`. It forks the current session (a byte copy of its append-only JSONL) into a fire-and-forget background child `pi` run that inherits the full conversation as context, works the side task in the same cwd (no worktree, no isolation), and reports back as a chat card rendered expanded by default. Because pi runs extension commands before the streaming queue, `/btw` works even while the main agent is busy; results are delivered only when the session is idle (deferred to `agent_end` while streaming) so the main turn is never interrupted, and an `on("context")` filter keeps `btw-result` cards out of the main agent's LLM context. Wired into `guided-workspace-setup` (pi extensions group) and documented in `docs/pi-setup.md` and `docs/pi-extensions.md`; run artifacts live under the gitignored `.pi/btw-sessions/`.
- 6e6fb85: Teach guided setup and docs about the `agent-hub` user-facing language override. The setup flow now offers the legacy `## agent-team` / `language: <value>` section for pi `agent-hub` targets, and docs/templates show how to configure it while preserving English as the default when the section is omitted.
- fd69214: Add a `deep-researcher` research persona (`gpt-5.5` / xhigh) alongside the existing `researcher` (`gpt-5.3-codex-spark`), so the agent-hub orchestrator routes read-only reconnaissance by difficulty: the light persona for simple reads, the deep persona for ambiguous, cross-cutting, or high-stakes investigation. The orchestrator's research-persona catalog now shows each persona's model and thinking level, and both orchestrator personas were rewritten to pick the right research tier — and to escalate non-research complexity by dispatching the right specialist, since `dispatch_agent` takes no model argument.
- 95a1a06: Load the hard-stop `damage-control` harness before `agent-hub` in the default `just hub` and `just hub-solo` recipes, and propagate it into spawned subagents: `agent-hub` now re-loads `damage-control` into every specialist and research helper via an explicit `-e` that survives their `--no-extensions`, so subagent tool calls (including `.env` and other secret reads) are checked against `.pi/damage-control-rules.yaml` instead of running unguarded. `damage-control` also now matches the `find` tool's `pattern` against zero-access paths, closing a gap where `find` could still locate secret files. Retire the `damage-control-continue` harness and recipe, hide the internal coms peer helper from `just --list`, and update the pi harness docs/setup guidance to describe the guarded hub launch and subagent safety scope.
- 747aebf: **guided-workspace-setup:** refresh the pi `justfile` and harness support files when harnesses change.

  The guided setup installed and removed pi harness _directories_ but never touched the `justfile` that launches them, so upgrading a workspace whose harness set had changed left a stale `justfile` — `just --list` still showed recipes for retired harnesses (pointing at deleted `.pi/harnesses/<name>/` dirs) and had no recipes for newly added ones (e.g. `hub`, `team-up` after the `agent-team` → `agent-hub` consolidation).

  The `justfile` and the harness support files (`scripts/team-up.ts`, `scripts/coms-net-server.ts`, the peer/team YAML and personas, `.pi/damage-control-rules.yaml`, `.pi/harnesses/package.json`) are now companions of the pi harnesses group: installing, refreshing, or removing any harness refreshes them in the same pass. The `justfile` is refreshed from the **current** source — which prunes retired-harness recipes and adds new ones — and is subject to the same status/diff rules as every other artifact, so a user-edited `justfile` gets the three-way diff instead of a silent clobber. User-authored recipes are protected by an `agent-skills:harnesses` managed-region sentinel: only that region is rewritten. The `justfile` is now also captured in the per-version `.versions/` snapshot so the upgrade three-way diff has a recorded baseline.

- 72772e2: Retire legacy standalone pi harnesses that are now consolidated into `agent-hub`, remove their just recipes and `agent-chain` YAML config, and update pi docs/guided setup to list the supported harness set.
- f861f75: **agent-hub / coms:** scope coms reachability to the connected pool, closing a cross-project leak.

  A peer that was reachable through the coms mesh but **not** shown in the default project-scoped pool widget could still be messaged — so an agent could talk to a peer it was never "connected" to (and, with `--explicit`, one deliberately kept private). `resolveTarget` matched a peer name by scanning _every_ project and never checked the explicit flag, so the send scope was wider than the display scope.

  Both `agent-hub` (embedded coms) and the standalone `coms` harness now treat the pool widget as the security boundary: `coms_list`, `coms_send`, and `/handoff` all resolve targets through one `peersInScope()` helper, so the reachable set is always a subset of what the widget shows. The two scope knobs — project (default: your own) and explicit-peer visibility (default: hidden) — are **human-only**: only `/coms --project <name>` / `/coms --all` can widen them. `coms_list`'s own `project` / `include_explicit` parameters may _narrow_ within the human-set scope but can never widen it; a widening request is ignored and flagged with a notice instead of silently honored.

  Out-of-pool `coms_send` / `/handoff` is refused with a message pointing at the human-controlled widening path — without confirming whether the peer exists elsewhere, since that existence is itself cross-project metadata. Tool descriptions and the dispatcher system prompt now teach the LLM that it can reach only pool peers and must ask the human to widen scope rather than attempt it, and not to pass cross-project context to a peer the human has not approved. `--explicit` peers are kept out of every pool until `/coms --all`.

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
