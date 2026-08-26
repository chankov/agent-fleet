# Agent Fleet changelog

## 1.0.4

### Patch Changes

- 7730d44: Add Compact/Verbose Fleet Detail logs with immediate event-driven refresh and a two-second recovery ticker. Local specialists, research helpers, and delegate children now expose wrapped assistant output, provider-emitted thinking, tool arguments, complete textual tool results, status, and duration. Per-run JSONL transcripts are owner-only, bounded in live memory, and redact common secret formats before persistence and display.
- 6885455: Make grilling of unspecified design forks mandatory during planning, spec writing, and implementation. Already-stated requirements in chat, prompts, PRDs, and rules are not re-asked; remaining multiple-valid-way, contradiction, and competing-code-pattern choices wait for an explicit decision.

## 1.0.3

### Patch Changes

- 10e9150: Add a two-step Fleet Dashboard model-substitution picker and make session-wide source-to-target mappings apply dynamically to future persona and delegate spawns. Bare `/af-agent-models-substitute` now opens the same picker while the two-argument form remains available.

## 1.0.2

### Patch Changes

- f2007a3: Replace Agent Hub's double-confirmation budget UX with one localized Yes/No `ask_user` confirmation. Accepted turn continuations renew the current turn in-place; accepted task continuations open an audited tranche while preserving task tier, assertions, capability packs, blockers, label, and progress. Exclude human `ask_user` wait time from both turn and task active-time clocks. Remove the redundant `/af-new-task` slash command; genuinely different work still resets through `set_task_tier(new_task: true)`. Add a visible inline `m` model picker over Fleet Detail logs that exposes every model Pi currently reports as available and applies the choice to a local specialist, research helper, or nested delegate's next run without interrupting current work. Normalize legacy and Kitty keyboard sequences so arrows and paging keys navigate the picker consistently.
- c028354: Add the read-only `/af-context` Agent Hub context-budget diagnostic with provider reconciliation and separate fleet context planes.
- e1e8bff: Refresh the root, MCP-extension, and harness runtime lockfiles to patched Pi, HTTP, schema-validation, and YAML transitive dependencies. Add an offline lock-floor regression so vulnerable resolutions cannot silently return.
- e1e8bff: Reduce standing Agent Hub context with automatic, intent-gated capability packs and selected managed-child context manifests. Prevent same-turn overflow with 80%/90% pressure diagnostics, single-flight automatic compaction, and exact-once deferred input replay. Restore persisted named rosters against current configuration while keeping stale orchestrator sessions fail-closed, and document recovery without session-file edits.

## 1.0.1

### Patch Changes

- ae46472: Prevent empty-roster research cards from crashing the Agent Hub, correct task active-time and new-task reset lifecycle accounting, and persist sanitized mode/reset routing diagnostics in Pi session entries.

## 1.0.0

### Major Changes

- 18da838: Replace guided LLM setup with three deterministic lifecycle commands:
  `setup`, `doctor`, and `uninstall`. Desired-state config, strict state-owned
  removal with human-config preservation, legacy alias migration, and
  preservation of overrides/STT config ship together in one major release.

  **Breaking for anyone who relied on the old guided flow.**
  `init` / `install` / `upgrade` / `update` remain compatibility aliases that
  route toward `setup` (or the legacy plan verbs) with deprecation warnings;
  `cleanup-installer` and the guided-workspace-setup skill/prompts are gone.
  Setup no longer accepts raw `--items` / `--profile` selectors — use
  `--preset <default|full>` and `--features <name[,name]|none>` instead.

  What changed:

  - **Desired-state config.** Selection lives in human-owned
    `.ai/agent-fleet.json` (preset + features). CLI flags are ephemeral unless
    `--save-desired` persists them. First-time migration from a state-only
    workspace requires `--migrate` with an explicit preset/features and `--yes`.
  - **Strict state-owned removal.** `uninstall` only removes paths recorded in
    `.ai/agent-fleet-state.json` whose bytes still match what we wrote. Human
    and foreign files are never touched. `--purge-config` is a separate explicit
    gate for `.ai/agent-fleet.json`, `.ai/agent-fleet-overrides.md`, and
    `.ai/stt.json`.
  - **Alias migration.** Deprecated `init`/`update` hand off to `setup`;
    `install`/`upgrade` keep plan-verb compatibility where needed and warn.
  - **Overrides and STT preserved.** Default uninstall and reconcile leave
    project overrides and voice STT config alone unless `--purge-config` is
    consented. Crash recovery uses `.ai/agent-fleet-transaction.json`.
  - **Conflict policy on setup.** Three-way conflicts abort before writes
    (exit `3`) unless resolved with `--on-conflict theirs|ours`. Legacy
    `upgrade` still uses `--accept-theirs` / `--accept-ours`.
  - **Just lifecycle and repaired setup UX.** `just fleet install` was removed;
    use `just fleet deps` for nested runtime dependencies. `just fleet setup`
    resolves the package through npm `@latest`. JSON setup now applies when
    consented with `--yes`, failed file transactions roll back rather than report
    success, and the interactive TUI can authorize a first legacy migration only
    after its exact migration preview and final confirmation.

  See `docs/agent-fleet-setup.md`, `docs/MIGRATION-agent-fleet.md`, and
  `docs/npm-install.md` for the operator-facing lifecycle.

### Minor Changes

- 9e37e72: Remove OpenCode support. OpenCode is no longer a recognized agent for any skill,
  persona, command, or harness. (This change left `claude-code` and `pi` as the
  install targets; a later change in the same release removes `claude-code` too,
  leaving pi as the only one.)

  **Breaking for OpenCode workspaces.** `--agent opencode` is rejected by every
  CLI verb, and the installer no longer knows the `.opencode/` paths, so it can
  neither install into nor clean up an OpenCode workspace. Anyone with an
  existing OpenCode install should delete `.opencode/agent/`,
  `.opencode/skills/`, `.opencode/commands/`, and `.opencode/orchestrate-teams.yaml`
  by hand before upgrading, then run
  `npx @chankov/agent-fleet@latest setup --preset default --features none --yes`
  for pi. Step-by-step: `docs/MIGRATION-agent-fleet.md`.

  What changed:

  - `detect-agent`, `manifest`, `transform-persona`, `bootstrap`, and `doctor`
    drop every `.opencode/` target path and the OpenCode persona transform
    (`mode: subagent` + tool denials).
  - `install-manifest.json` regenerated: 101 items, no `opencode` bindings.
  - `.opencode/` and `docs/opencode-setup.md` deleted from the package; the
    `opencode` keyword removed from `package.json`.
  - `/compound` is gone as an installable command — it only ever shipped as an
    OpenCode command file. Invoke the `compound-learning` skill directly on
    Claude Code; pi keeps `/af-compound` via the `agent-hub` harness.
  - Docs updated across README, AGENTS.md, CLAUDE.md, and `docs/`.

  `.versions/<x.y.z>/` snapshots are left untouched — they are the record of what
  each past release actually shipped, and the version-aware update flow diffs
  against them.

### Patch Changes

- baa2617: Unify `ask_user` ownership across runtime modes. `ask-user-remote` now treats a settings-listed `pi-ask-user` entry as dormant under `--no-extensions`/`-ne` (so default `just fleet` still registers the wrapped tool), defers only when extension discovery can actually load the stock package, and resolves stock `pi-ask-user` from package-native, `.pi/npm`, harness runtime (`npm ci --prefix .pi/harnesses`), then global locations. Align root and harness dependencies on `pi-ask-user@^0.14.0`. `doctor`/`verify` emit a read-only `pi-package-ownership` advisory when package-native Agent Fleet skills/prompts overlap copied `skill:*`/`command:*` items.
- f24bed3: Correct and expand the install/update documentation for the deterministic
  lifecycle.

  Three corrections, each of which was actively misleading:

  - **First install no longer tells you to run `just fleet setup`.** The managed
    justfile region is written _by_ setup, so in a repository without Agent Fleet
    that command fails with `error: no justfile found`. README, `docs/getting-started.md`,
    `docs/npm-install.md`, `docs/MIGRATION-agent-fleet.md`, and the `just fleet help`
    banner now lead the first install with `npx @chankov/agent-fleet@latest setup`
    and present `just fleet setup` as the wrapper available once the workspace has
    a justfile.
  - **`setup` does not preserve local edits.** README, `docs/agent-fleet-setup.md`,
    and the migration guide claimed reconciliation "never eats a local edit". Under
    `setup` a locally modified owned file is refreshed and the edit is overwritten
    (`plan.js` plans it as `refresh … overwrites: true`); only the deprecated
    `upgrade` verb preserves it. The docs now state this plainly, show the plan line
    that predicts it, and point at `.ai/agent-fleet-overrides.md` as the supported
    customization route.
  - **The runtime-dependency step was easy to miss.** The two `npm` companions are
    `consent: exec` and plan as `skip`, so a workspace is not launchable until
    `just fleet deps` (or `setup --allow-exec`) runs. It is now part of the install
    sequence rather than an aside.

  New material: a step-by-step **"Updating an existing install"** section covering
  the update banner, `check-update`, the `--dry-run` preview and how to read each
  action line, applying, and resolving an exit-`3` conflict with `--on-conflict
theirs|ours`; and a per-state table of what reconcile does to every file,
  including the degraded two-way comparison when a `.versions/` baseline is absent.

  `docs/MIGRATION-agent-fleet.md` is rewritten from a lifecycle-only matrix into a
  guide to all four breaking changes in this release — the deterministic lifecycle,
  Claude Code losing install-target status, the OpenCode removal, and the unified
  `just fleet` runtime — each with the commands to migrate an affected workspace.

- 886a3ad: Remove Claude Code as a coding-agent install target. pi is now the only agent the installer writes for; Claude Code stays in the fleet as a coms peer and nothing else.

  **What is gone**

  - `.claude/commands/` (15 slash commands, including `/orchestrate`) and `.claude/orchestrate-teams.yaml`
  - `.claude-plugin/` — Agent Fleet is no longer published as a Claude Code plugin; npm is the only distribution channel
  - `hooks/session-start.sh`, `hooks/simplify-ignore*.sh`, `hooks/SIMPLIFY-IGNORE.md`, `hooks/hooks.json` — all Claude-Code-runtime hooks
  - `agent-fleet transform-persona` and `bin/lib/transform-persona.js`. Personas were only ever translated _for_ Claude Code; `agents/*.md` is already pi's own dialect, so `bin/lib/personas.js` now just enumerates them and the install strategy is a plain `copy-file`
  - The `transform-persona` install strategy, the `references-hooks` manifest group, and the interactive "which coding agent?" prompt

  **What replaces it**

  - `--agent` is still accepted and validated everywhere, but defaults to `pi` and is never asked for. `detectAgent()` has nothing left to detect
  - References move from `.claude/references/` to `.pi/references/` and stop being a standalone menu section: each one is declared a **companion of the skills that cite it**, so installing `code-review-and-quality` brings `security-checklist.md` and `performance-checklist.md` with it, and uninstall refuses to strand a skill without its checklists
  - A new `coms-bridge` manifest group holds the two halves of the Claude Code bridge — `skill:peer-coms` and `hook:coms-stop-hook`, the latter as a companion of the former. The hook still installs to `.claude/hooks/` under the **pi** agent, because the pane reading it is a Claude Code process. Registering it in `.claude/settings.json` remains a manual step, documented in `docs/claude-code-coms-bridge.md`

  **Unchanged**

  The bridge itself: `scripts/coms-claude-bridge.ts`, `scripts/lib/claude-bridge-core.ts`, `skills/peer-coms/`, the `_claude-peer` justfile recipe, `runner: claude-code` peers in `.pi/agents/peers.yaml`, and the `dispatch-policy.yaml` routing that lets a bridged pane serve an agent-hub team member's dispatch. Cross-model review through a standing Claude session works exactly as before.

  **Upgrading.** A workspace previously installed for `claude-code` is not migrated automatically — its `.claude/` artifacts are no longer in the catalogue, so `verify` will not claim them and `uninstall` will not remove them. Reinstall for pi with `npx @chankov/agent-fleet@latest setup --preset default --features none --yes` followed by `just fleet deps`, then delete the leftover `.claude/` skills, commands, agents, and references by hand — keeping `.claude/hooks/` if you use the coms bridge. Step-by-step: `docs/MIGRATION-agent-fleet.md`.

- 1e9c829: Unify Pi Fleet startup behind one guarded Agent Hub runtime. Bare `just fleet` now loads Fleet Core plus Agent Hub in operator posture, preserving direct coding tools and starting with an empty native roster. Use `--posture`, `--agents`, `--herdr`, `--peers`, `--project`, and `--no-coms` to select execution posture, native specialists, workspace topology, project scope, and communication capabilities independently.

  Add live `/af-posture` switching, on-demand native roster growth, deterministic `dispatch_agent` routing through `backend: auto|native|coms`, and same-project dynamic Pi or Claude Code peer spawning through Herdr. `just fleet hub`, `just fleet team <preset>`, team `--no-hub`, and `--solo` remain accepted for one migration release and print their canonical replacements.

## 0.0.11

### Patch Changes

- e0d684c: Document the terminal-specific macOS requirement for Pi Alt shortcuts: terminals must send Option as Meta, and Zed users should enable `terminal.option_as_meta`. This preserves the existing cross-platform shortcuts and avoids presenting a Zed configuration fix as an OS-wide keybinding change.
- 517e4c5: Keep the default macOS monitor Unix socket below the platform path limit, and disable monitoring safely when an explicit runtime root would overflow it.

## 0.0.10

### Patch Changes

- c7a821c: Make `install` and `upgrade` real: the apply engine (Phase 4 of `plans/deterministic-installer.md`, completing Phase 5).

  A brand-new repository can now be set up with one command and no coding agent in the loop:

  ```
  npx @chankov/agent-fleet@latest install --agent pi --profile recommended --yes
  ```

  - **`agent-fleet install`** applies a plan: copies, symlinks (`--method symlink`), generates personas through the tested transformer, rewrites the `justfile` managed region, and merges only agent-fleet's own keys into `.claude/settings.json`. Run without a selection in a terminal it asks which profile; piped, it requires the flags rather than guessing. `--yes` skips the single confirmation; `--allow-exec` admits the items that run a command, which are ordered after all file work so they see the finished tree.
  - **`agent-fleet upgrade`** applies the three-way merge: clean upgrades land, local edits are preserved, and a file changed both locally and upstream is written beside yours as `<file>.new` while your copy is left untouched (exit `3`).
  - **State and record.** Every pass writes `.ai/agent-fleet-state.json` — per-file hashes, ownership, method, version — and renders `.ai/agent-fleet-setup.md` from it, so the human record can no longer disagree with the machine one. The state file is written even when a pass fails partway, so a workspace never holds files it has no record of.
  - **Safety is enforced, not documented.** Nothing is written outside the workspace, nothing is deleted that the state file does not record as ours, and nothing you have edited is deleted at all — a removal reports what it kept and why.

  `verify` now compares the two shared-file forms for real (a managed region by its sentinel-bounded block, a JSON merge by its declared key paths) instead of reporting them as unchecked, so your own `justfile` recipes and settings keys never read as drift. Installing twice is a no-op, asserted in tests.

  Unchanged: `init`, `doctor`, `update`, `cleanup-installer`, and the guided setup skill.

- c7a821c: Add the deterministic installer's planner and the upgrade three-way merge (Phases 3 and 5 of `plans/deterministic-installer.md`).

  - **`agent-fleet install --profile <name> --dry-run`** — resolves a selection (profiles ∪ explicit item ids, closed over `requires` and `companions`) against the workspace and prints the exact action list: what would be created, refreshed, repaired, kept, or skipped, in an order where every requirement precedes the item that needs it. A selection never removes anything; a narrower profile keeps what is already installed.
  - **`agent-fleet upgrade --dry-run`** — plans an upgrade of what the workspace already has, using the `.versions/<recorded>` snapshot as the merge base. An untouched file that moved upstream is refreshed; a locally modified file whose source did not move is preserved; a file changed in both places is reported as a conflict and never resolved by guessing. `--accept-theirs` / `--accept-ours` resolve conflicts non-interactively, and an artifact retired upstream is proposed for removal by name.
  - **Consent classes are enforced at plan time.** `exec` items are skipped unless `--allow-exec` is passed, and `external` / `operator` items are reported as steps the engine will never perform.
  - Exit codes: `0` clean, `1` could not plan, `3` conflicts needing a decision.

  `plan()` reads the filesystem and writes nothing; `verify` and both new verbs now share one workspace evaluation (`evaluateWorkspace`), so they cannot disagree about a file's state. Golden plans for a fresh `pi` / `claude-code` / `opencode` workspace are committed, so a change to the recommended set shows up as a reviewed diff.

  Applying a plan lands with the apply engine in Phase 4; until then both verbs require `--dry-run` and refuse to run without it. `init`, `doctor`, `update`, `verify`, and the guided setup skill are unchanged.

- c7a821c: `doctor` repairs through the install engine, and `uninstall` lands (Phase 6 of `plans/deterministic-installer.md`).

  - **`agent-fleet doctor [--fix]`** now has two halves in one report. Recorded items that are missing, dangling, or linked outside the source root are rebuilt through the _same_ `apply()` path `install` writes with — a repaired file is byte-identical to a freshly installed one. The old scan stays for what the install record cannot own: broken links in a pre-engine workspace, and stale persona names in `.pi/agents/*.yaml`. Overrides problems and malformed `peers.yaml` entries remain advisory. Exit `2` when anything repairable is left, `--json` for the machine report, `--dry-run` to look without being asked anything.
  - **`agent-fleet uninstall --items <id,…> | --all`** removes what the state file records, and only that. A recorded file whose bytes no longer match what we wrote is kept and listed as skipped. A companion travels with its parent unless another installed item still needs it, and an item another installed item pins is refused by name — so removing one pi extension cannot delete the `package.json` five others run from, and removing `damage-control-continue` while `agent-hub` is installed is refused rather than silently leaving the hub without its safety harness. Removing the last pi harness strips the `agent-fleet:harnesses` region from the `justfile` and leaves the rest of the file alone.
  - **Hermes and Codex are real profiles.** `install --profile hermes-plugins --dry-run` (and `codex-bridge`) prints the exact command list for each artifact and touches nothing. Their targets are a Hermes profile and a user systemd unit — outside the workspace, the one place the engine writes — so they stay `operator`-consent by design. Every operator item now declares its steps in the manifest, and the manifest build fails if one does not.

  Two fixes to the write path, both cases where a filesystem call silently did nothing:

  - A **dangling symlink was never replaced** — `rmSync(path, { force: true })` stats through the link, saw ENOENT, and returned as if the path were already gone, so the replacing `symlinkSync` failed `EEXIST`. Repairing a broken link is exactly the case that hit this.
  - **Emptied directories were left behind** on removal — the non-recursive `rmSync` throws `EISDIR` on any directory, so the prune walk aborted on its first step.

- c7a821c: `guided-workspace-setup` becomes a front-end over the installer instead of the installer (Phase 7 of `plans/deterministic-installer.md`).

  The skill is 544 lines shorter than it was — 220 down from 544 — because everything it used to describe now runs as code. Gone: the per-agent path table, the item-state table, the merge rules, the removal-ownership rules, the harness companion closure, and the `af-` migration procedure. What remains is what a program cannot do: ask which artifacts a project wants, draft `.ai/agent-fleet-overrides.md` from a scan of the workspace, and run the `pi-voice-stt` provider Q&A.

  - **One command builds the menu.** `verify --json` now carries `groups` (agent-filtered), `profiles`, and per-item `subcategory`, `title`, `summary`, `recommended`, `owned`, and `state` — so the selection screen comes from a single call, and no front-end recomputes an item's state by eye.
  - **The five setup/doctor slash commands were rewritten the same way.** They had each accumulated their own copy of the same rules.

  Three rules that had only ever existed as prose are now encoded, and tested as behaviour:

  - **Fleet Core** — the set `just fleet` loads into every session — is `requires` plus `pinnedBy` in the manifest. Installing any pi harness pulls the whole closure; uninstalling a member while a harness is installed is refused. A test parses `fleet_core_extensions` out of the `justfile` and fails if the manifest disagrees.
  - **The `af-` prompt migration.** A workspace set up before the namespace still has `.pi/prompts/spec.md`, and pi keeps offering `/spec` from it. Commands now declare the unprefixed path they replaced; installing retires it under the ownership rule (a same-named prompt you wrote yourself is kept), and `verify` reports a surviving one as an advisory finding.
  - **Stripping the `justfile` region.** Removing the last pi harness used to leave the managed block behind, so `just --list` kept advertising recipes for deleted harness directories.

  Docs updated: `docs/npm-install.md` (the `doctor`, `uninstall`, and consent-class sections; CI usage is now the no-LLM install), and `docs/agent-fleet-setup.md` (the state file and the three-way merge, replacing the prose status table).

- c7a821c: Add the deterministic installer's catalogue and read-only inspection pass (Phases 0–2 of `plans/deterministic-installer.md`).

  - **`install-manifest.json`** — a generated catalogue of every installable artifact: source candidates, per-agent target and strategy, group, recommendation, consent class, and companion wiring. Built from the repository tree by `node bin/build-manifest.js`; `--check` fails when the committed copy is stale, so an artifact landing without a menu row is a test failure rather than a silent omission. Only judgement (grouping, recommendations, consent, companions) is hand-edited, in `manifest-meta.json`.
  - **`agent-fleet verify`** — a read-only report of a workspace against the manifest: what the new `.ai/agent-fleet-state.json` records, what is on disk, and what the current package ships, including the three-way comparison against the `.versions/<recorded>` snapshot. Writes nothing. Supports `--agent`, `--workspace`, `--json`, `--no-doctor`, and exits `0`/`1`/`2`. The existing doctor findings are folded into the same report; findings are split into `problem` and `advisory`, and only problems affect the exit code.

  No existing behaviour changes: `init`, `doctor`, `update`, and the guided setup skill are untouched.

- 63cb0eb: Rewrite the setup docs around the deterministic CLI installer.

  `README.md`, `docs/getting-started.md`, `docs/pi-setup.md`, `docs/opencode-setup.md`, and `docs/pi-extensions.md` still described the pre-engine world: `ln -s` chains into `.agents/skills/` and `~/.config/opencode/`, "symlink mode in `/setup-agent-fleet`", and `git pull` as the update mechanism. All of that is replaced by the verbs that actually do the work.

  - **The no-agent path is documented first.** `install --agent <a> --profile <p> --yes` needs no coding agent and no model; `init` is presented as the conversational front-end over the same engine, not as the only way in. Profiles, `--items`, `--dry-run`, `--json`, and the exit codes are named where a reader would look for them.
  - **Every symlink recipe is gone from the install paths.** Artifacts install as copies; freshness comes from `agent-fleet upgrade` and its three-way merge, not from editing a link target. `--method symlink` appears only where it is still true — inside an agent-fleet checkout.
  - **pi setup is restructured into three paths** (CLI installer, pi package, clone for contributors) with a table of where each artifact kind lands. The clone path now installs _from_ the checkout (`node /path/to/agent-fleet/bin/cli.js install --workspace <project>`) instead of linking into it.
  - **`--allow-exec` is explained where it bites**: the `npm ci` steps for `.pi/extensions/` and `.pi/harnesses/` are a separate consent class, printed and skipped without the flag.
  - **OpenCode gains a project-scoped install section**; the manual `~/.config/opencode/` symlink recipe is kept but labelled as the advanced machine-wide alternative the CLI deliberately does not cover.
  - Extension READMEs (`btw`, `compact-and-continue`, `agent-fleet-update-check`, `chrome-devtools-mcp`, `mcp-bridge`) and the `browser-testing-with-devtools` skill now give the `--items` command instead of an `ln -s`. `chrome-devtools-mcp` documents that `pi-extension:mcp-bridge` must be selected alongside it — it is not pulled in as a companion.

  Every command added to the docs was verified against the CLI by dry-run.

- 8c64b6b: Make the agent-hub's cost guardrails bind on a TASK rather than on a message, and stop the four escalation paths that turned a one-line change into a two-day run.

  The failure this comes from: a request to add two missing Key Vault permissions produced a 493-line PRD, a 1216-line plan with hash-pinned manifests and a fixture suite, and 47 hours in one workspace — while the same change, made in a narrow workspace with two agents, took 13 minutes. Every existing guardrail was in place and none of them bound, because all of them were scoped to a user message.

  - **Task-scoped budget** (`run-budget.js`) — a second envelope, `3×` the turn envelope, whose counters are **not** reset by a user message. Exhausting it is a hard stop; only `/af-new-task [label]` (or `set_task_tier` with `new_task: true`) opens a new window. Turn budgets refilled on every steering message, so a steered run could never hit one. The task clock charges **active** time only (turns that ran, minus `ask_user` waits): billing human idle would false-stop a normal steered session, and a false stop teaches people to reset the window reflexively. The auto-research pipe stays exempt from the turn budget but **is** charged against the task envelope — at 2 rounds × 4 questions per dispatch it would otherwise smuggle up to 144 research runs past the outer bound.
  - **Ratcheted, task-scoped tier** — the task tier now survives the user's next message and moves one way cheaply: lowering is free, raising requires a `reason` naming what the ask turned out to contain. Previously the tier reset to null on every message and the next dispatch re-assumed `feature`, so a two-word correction bought six fresh dispatches. A skipped triage now assumes **`small`**, not `feature`: the tier latches for the whole task, and a never-declared tier is precisely the case where proportionality was not being considered — assuming `feature` there granted the whole apparatus for forgetting a tool call. An assumed tier is not a ratchet baseline, so the dispatcher's own first `set_task_tier` still needs no reason.
  - **Tier persona gate** — at `trivial`/`small`, `dispatch_agent`/`spawn_research` refuse `planner`, `plan-reviewer`, `architect`, `security-auditor` and `deep-researcher`. Each opens a document/finding loop whose output must then be executed and re-reviewed. The refusal costs no budget slot and names the escape hatch (raise the tier, with a reason).
  - **Review round cap** — review dispatches per task are capped by tier (trivial/small 1, feature 2, project uncapped); the next one is refused without spending a budget slot. This is where the review ratchet is cut, because closing it needs a second round.
  - **Review finding budget** — review personas are dispatched with a blocking-finding cap tied to the tier (trivial 1, small 2, feature 5, project uncapped), plus the rule that a blocking finding may only enforce an invariant the task, plan, or project rules already state. The hub **counts** the returned findings (`review-findings.js`) and appends a visible over-budget notice, but deliberately never reclassifies one: no rule the hub can evaluate separates "invents a manifest nobody asked for" from "this logs a connection string", and silently demoting the second by position would move a real security finding into the section nobody acts on.
  - **Docs lane** (`docs-lane.js`) — a dispatch whose whole `scope` is documentation refuses review personas (overridable per dispatch with `review_reason`) and tells the dispatcher not to open a review gate. An absent scope is never the lighter lane.
  - **External-blocker stop** (`external-blocker.js`) — specialists emit `EXTERNAL_BLOCKED: <what is missing, who owns it>` when they need something outside the fleet's reach; the hub refuses the next dispatch with an owner-escalation packet until the human is addressed. This replaces the observed alternative: substituting internal work — scripts, manifests, fixtures, diagnostic packets — for a missing external fact for hours, with the assertion still ending UNPROVEN.
  - **Immutable per-run artifact namespaces** (`run-namespace.js`) — session start now archives the previous session's artifacts into `.pi/agent-sessions/runs/<runId>/` with a read-only `meta.json` and an appended `runs/index.json`, instead of deleting them. Retention is the new `run-history-keep:` overrides key (default 10, `off` keeps everything). The old wipe plus per-session `builder-runN.md` naming is what made a post-mortem record eleven specialist returns and two reviews as NOT RECOVERABLE.

  Supporting changes: `orchestrator`, `plan-reviewer` and `code-reviewer` personas carry the matching proportionality rules, and `spec-driven-development` and `planning-and-task-breakdown` gain a proportionality gate so the personas do not fight the code gates.

- c7a821c: Symlink installs are retired for ordinary workspaces — artifacts install as copies.

  `--method symlink` is now accepted only when the target workspace **is** an agent-fleet checkout (its `package.json` names `@chankov/agent-fleet`) — the one place where editing an installed artifact is _meant_ to edit the source. Everywhere else a symlink install is a trap: the link target can never move again, an npx cache clean breaks every link at once, a `git pull` in the source silently rewrites artifacts the workspace never agreed to change, and Windows needs Developer Mode. A copy plus `agent-fleet upgrade` gives the same freshness with a real three-way merge behind it.

  - `--method` is gone from the help text of `init`, `install`, `upgrade`, and `update`. An explicit `--method symlink` outside a checkout is **refused** with an explanation, not silently downgraded — a flag you typed deserves an answer.
  - **Existing symlink installs migrate automatically.** `verify` reports the workspace with a new advisory `symlink-retired` finding, and the next `install` or `upgrade` re-materialises every linked item as a real file and flips the recorded method to `copy`. Local edits are still preserved by `upgrade`'s merge; nothing is lost in the conversion.
  - `guided-workspace-setup` and the three setup slash commands no longer ask copy-vs-symlink at all. There is no question left to ask.

  Inside an agent-fleet checkout nothing changes: `--method symlink` still works, and that is the case the mode now exists for.

## 0.0.9

### Patch Changes

- 5a3fa84: `just fleet peer <name>` now launches the peer in a Herdr pane of its own, and can launch any kind of peer — including Claude Code.

  **Behavior change:** `just fleet peer <name>` used to turn the _calling terminal_ into a pi peer. It now opens a pane instead. Pass `--here` for the old behavior; the command it runs there is byte-identical to before.

  Launching a Claude Code peer previously meant declaring it in `.pi/agents/peers.yaml` and running `just fleet team <preset>`, which builds a whole workspace. There was no way to say "give me one more agent, next to what I already have".

  - The **name decides the shape**: a name declared in `peers.yaml` keeps its `runner`/`model`/`extensions`/`env_file`; a name matching `agents/<name>.md` becomes that guarded persona peer; anything else is the identity-only Fleet Core peer this command always launched. `--runner claude-code` needs no manifest entry at all. Note the second rule also changes meaning for existing invocations — `just fleet peer architect` is now the architect persona peer, because `agents/architect.md` exists. `--no-persona` forces the plain shape back.
  - **Placement**: inside a Herdr pane it splits _that_ pane (`--direction right|down`); outside Herdr it creates a single-pane workspace labelled `<worktree-tag>-peer-<name>`, refusing to clobber an existing one; `--here` runs it in the calling terminal.
  - New flags: `--runner pi|claude-code`, `--persona`, `--no-persona`, `--model`, `--extensions`, `--direction`, `--here`, `--dry-run`. `--browser` now also works on a persona peer, where it adds `chrome-devtools-mcp`. Raw pi arguments move behind a `--` separator (`just fleet peer architect --here -- --session …`).
  - **Nothing is silently dropped**: a flag that cannot apply to the resolved peer shape is an error, not a no-op — `--all-extensions` on a persona peer, `--persona` on a Claude Code peer, a mistyped flag, or a pi flag that forgot its `--`.
  - A pane launch waits (bounded) for the peer to register in the coms pool and exits non-zero with the pane's last output when it never does — the same "failed, not slow" policy `herdr_spawn_peer` uses.
  - `--dry-run` prints the resolved plan and placement without touching Herdr, and never reads `env_file` values.

  Pure logic lives in `scripts/lib/peer-launch.ts` under `node --test`; the Herdr wiring is `scripts/peer-launch.ts`, reusing the existing command builder (`peerCommand`) and pane-launch helper so hub spawns, team spawns, and CLI launches stay one behavior.

  `spawned-peers.js` (pane launch + readiness policy) moves from `.pi/harnesses/agent-hub/` to the shared `.pi/harnesses/lib/`, because the fleet scripts are installed into target projects that may not have selected the `agent-hub` harness. Both new scripts are added to `companion-manifest.json` so guided setup installs and refreshes them with the rest of the runtime closure.

- f62cfe0: Fix `herdr_spawn_peer`: it opened panes without ever launching the peer.

  herdr's `pane.split` takes no `command` — a split always opens a plain shell — and the server silently ignores unknown params. agent-hub passed `command: argv` to it, so every hub-spawned "peer" was an empty shell pane with the right label, the tool reported success, and the readiness wait then timed out on a peer that had never started. `just fleet team` was unaffected because it launches through `layout.apply`, whose pane nodes do carry an argv.

  - The spawn now splits, waits for the new pane's shell prompt, and types the command line (text and Enter sent separately — bash bracketed paste swallows a newline inside sent text).
  - Spawned peers join **this session's coms project pool** instead of always `default`, which had put them in a pool the hub cannot see.
  - A name declared in `.pi/agents/peers.yaml` keeps its declared `runner:`, `extensions:`, and `env_file:`, so spawning `code-reviewer` produces the peer the fleet defines rather than a plain pi persona.
  - Hub spawns honor the stale-OAuth spawn stagger that team launches already used, so back-to-back spawns cannot lose the credential lock race.
  - `peer_ready: false` now returns the pane's last output and states that the peer failed to start; the orchestrator persona and hub guidance say not to send to it or spawn around it.
  - `paneSplit` no longer advertises a `command` param, and the client test pins `pane.split` to its real wire shape.

- c7f42e0: The version shown by every `just fleet` harness now reads `agent fleet v<version>` instead of a bare `v<version>`, so a pi session started outside this project says whose version it is — and `agent fleet` is a clickable OSC 8 terminal hyperlink to the project homepage.

  The shared status entry registered by `agent-hub`, `coms`, and `damage-control-continue` and the agent-hub footer (`agent fleet v0.0.7 · <model><thinking> · <team>`) both take the label from one `formatVersionLabel()` helper in each harness's local `version.ts`, so the two surfaces cannot drift.

  The link is terminal-level, not a TUI control: pi has no mouse tracking, so a click hands the URL to the OS opener rather than opening an in-process overlay. Terminals without OSC 8 support render the label as plain text, and pi's `visibleWidth`/`truncateToWidth` strip OSC sequences, so the link costs no footer columns. Set `AGENT_FLEET_NO_LINKS=1` for a plain label on multiplexers that mangle unknown OSC sequences (GNU screen, tmux before 3.4).

## 0.0.8

### Patch Changes

- d04411a: Include `scripts/lib/monitor-env.ts` in the guided workspace setup companion manifest so copy and symlink installs can load the unified `just fleet` entrypoint.

## 0.0.7

### Patch Changes

- 9a5091c: Fallback failed or aborted agent-hub model overrides, including local-model memory-limit failures, to the persona's original model before any text or tool work begins.
- 72ff5e1: Fix `started_at` on bridged Claude Code peers, which reported an uptime of at most 30 seconds.

  `scripts/coms-claude-bridge.ts` rebuilt its entire registry record on every 30s keepalive, and the builder set `started_at: nowIso()` — so the field never held the start of anything and the Hermes fleet panel showed every bridged Claude pane as freshly started, forever. This is the third copy of the bug that Phase 1 of the fleet-observability work fixed for the two pi harnesses; the bridge now reuses that same `buildLiveRegistryEntry()` instead of keeping its own. Registration captures `started_at` once; the keepalive carries it forward and moves `heartbeat_at`.

- 72ff5e1: Show what a fleet agent is actually doing, not merely that it is doing something.

  The Hermes panel could say `working`. True, and useless — it is the same word for an agent compiling, an agent stuck in a retry loop, and an agent that has been reading the same file for four minutes. `hermes/plugins/agent-fleet-herdr/dashboard/activity.py` reads the agent's own transcript and turns it into a timeline, so a selected row now reads `working · 3m12s · bash git rev-list…` with the steps that led there underneath. It needs nothing from the hub, herdr or a lease: the transcript is written whether or not anybody is watching, which makes this the only part of the panel that also works for a `detached` session no pane hosts.

  **The slug narrows, `boot` decides.** A cwd routinely holds a dozen transcripts — every resumed session, every restart — and a pi pane and a Claude Code pane can share one exactly. The match is `coms-log/boot.session_id == registry.session_id`, and a candidate whose boot names a different session is skipped rather than used as a fallback. Picking the wrong transcript is not "no data"; it is confident fiction about what another agent is doing.

  **Bridged Claude Code peers get a tail too, through a link that had to be created.** `coms-claude-bridge.ts` mints its own coms session id and Claude Code has never heard of it, so no shared identifier existed anywhere on disk. `hooks/coms-stop-hook.mjs` now records `transcript_path` alongside the turn text it already writes — an additive key the bridge ignores — and the reader follows registry → herdr pane → hook record → `~/.claude/projects/*.jsonl`, handling the second dialect (`tool_use`/`input`, PascalCase names, `stop_reason`) behind the same projection. A peer whose hook has never fired says so instead of guessing, and because the chain runs through the pane, a _detached_ Claude Code peer cannot be matched at all — the opposite of the pi case, and stated rather than papered over.

  **Projection, not forwarding.** A transcript holds everything the agent has ever read. `thinking` blocks, `toolResult` output and `user` turns never travel; a tool's arguments pass a per-tool allowlist (`bash` yields its command, `read` a path, `dispatch_agent` the target), a tool nobody listed yields its name and nothing else, and an argument that is a dict where a string was expected renders as nothing rather than being `str()`d into the payload. The two dialects keep separate maps so `Read` cannot inherit `read`'s fields.

  `GET …/sessions/{project}/{name}/activity?after=<seq>` is cursor-based on a **byte offset into the transcript** — monotone within a file, no state on either side — with reads capped at 256 KB, parses cached on `(path, size, mtime)`, and both ends of the tail cut so a record we split and a record still being appended are never parsed. It returns **no errors**: no transcript, no registry entry, an unreadable file are all a 200 with `available: false` and a reason, because a session with nothing on disk to read is ordinary and a red box every three seconds is not. The herdr lookup a bridged peer needs runs only for `model: "claude-code"`, so a pi peer never pays for it.

  In the pane it is the modal rather than the row — opening a session is the request for detail, and a transcript read per row per 3 seconds would turn a status panel into a disk load. The description line degrades a piece at a time: an unreadable timestamp drops the age and keeps the action, and no transcript at all leaves the verdict standing alone with the reason underneath.

- 72ff5e1: Push fleet events to the herdr pane over a WebSocket instead of waiting for the next poll, without giving up the poll.

  `WS /api/plugins/agent-fleet-herdr/events/stream?after=<seq>` serves the same ring buffer `GET /events` already serves — same events, same sequence numbers, same cursor — as a first frame carrying the backlog past `after`, then one frame per batch as it happens, and an empty `keepalive` frame every 20s of silence. This is the plan's Phase 5, and it lands last on purpose: latency was only worth spending on once Phases 1–4 had made something worth pushing.

  **The poll is the contract; the socket is the accelerator.** `ctx.socket` is a documented no-op on OAuth remotes and gives its caller no close event, so the pane never stops polling — it steps `/events` down from every 5s to every 30s while frames are arriving and back up the moment they stop (`shouldPollEvents`). Nothing has to detect a broken socket, because nothing was ever switched off, and the 30s floor is also what recovers a batch the stream dropped. Both feeds run through one handler and one cursor in the renderer, which is what makes them interchangeable rather than additive: `presentEvents(payload, primed, after)` filters by `seq`, so the same event delivered by both is a wasted frame instead of a duplicate toast, and a frame that overtakes another cannot rewind the cursor.

  **The route has to authenticate itself, which was not obvious.** Every gateway middleware — the auth gate _and_ the one that 404s a plugin missing from `plugins.enabled` — is registered for the `http` scope, so a WebSocket upgrade reaches a plugin router with nothing checked at all. `_socket_gate()` re-runs the gateway's own `_ws_request_is_allowed` / `_ws_auth_ok`, looked up in `sys.modules` rather than re-imported, plus the enabled check. **Unresolvable means refused**: a Hermes that renames those functions gets no stream and a pane that keeps polling, because the alternative is an upgrade quietly converting this into an unauthenticated event feed.

  **`EventStream` subscribes before it reads the backlog.** The other order has a hole in it — an event landing between the two would be in neither — and this order can only produce a duplicate, which the cursor filter drops. Its per-socket queue is bounded at 64 batches and drops rather than growing without bound; the batch arrives late via the poll instead of never, which is the second reason the poll stays. `Watcher.subscribe()` fans batches out to live listeners on whatever thread observed the snapshot, under the same rule as the outbound sinks: a listener that raises costs a line on stderr and never stops the watcher.

  `/capabilities` gains `events_stream: true` — not a source, a version marker: backend routes mount at app construction, so the presence of that key is the honest answer to "has Hermes restarted since the plugin changed".

  The optional half of the phase — replacing the `herdr agent list` subprocess with a JSON-lines socket client — is dropped on measurement rather than taste: seven runs of that command take 3.1–4.6ms, which at a 3s interval is not something a human can perceive, and the alternative is a second implementation of herdr's protocol in Python.

- 72ff5e1: Revive the agent-fleet-monitor and fold its task tree into the herdr pane, so a hub's subagents can be watched and stopped from one panel.

  The monitor was fully wired into `agent-hub` — twelve call sites publishing every child run, its output and its exit — and had never once started, because `monitorLifecycleConfig()` returns `null` without `AGENT_FLEET_PROFILE_ID` and `AGENT_FLEET_MONITOR_RUNTIME_DIR`, and the only thing that ever set them was a manual `export` copied out of a README. Roughly 95 KB of source behind 40 test files was dead in practice. This is the "revive" exit of the plan's Phase 4 decision, taken because the activity tail cannot do the two things the monitor can: show a subagent's raw stdout, and **cancel** it.

  **The launchers now decide.** `scripts/lib/monitor-env.ts` resolves both variables — the `dev` profile by default, `$XDG_RUNTIME_DIR/agent-fleet-monitor` created mode 0700 — and `scripts/fleet.ts` merges them into every `just fleet` mode. `scripts/team-up.ts` passes them as **pane env** instead, because the hub pane is spawned by a herdr daemon that inherits nothing from the launcher, and a `just fleet team` hub is the one most likely to want a task tree. An operator's own export always wins, `AGENT_FLEET_MONITOR=0` opts out, and a runtime directory that cannot be made 0700 leaves the hub unmonitored rather than handing the Python reader a path it will refuse.

  **One pane, not two.** `hermes/plugins/agent-fleet-herdr/dashboard/tasks.py` serves `GET …/sessions/{project}/{name}/tasks`, and the selected row's modal grows a subagent tree with each live child's stdout under it and a Cancel beside it. The description line gains the count, because a hub whose own transcript is idle while three specialists work is exactly the case the panel used to render as "nothing is happening". The monitor's separate Desktop panel is left uninstalled — folding the tree in is what makes it unnecessary.

  **The join is `hubPaneId`, an identifier that already existed on both sides.** A monitor child records `env.HERDR_PANE_ID` of the hub that spawned it; the panel already takes a herdr pane snapshot per poll. One id, written by one process, read by both — no cwd guessing and no "newest hub wins". The consequence is stated rather than hidden: correlation runs through the pane, so a `detached` hub shows no tasks, the same limit bridged Claude Code peers have on the activity tail.

  **Cancel re-derives ownership before it trusts an id.** The renderer names a task it read from `…/tasks`, but a renderer is not a trusted source: the id is looked up again in a fresh snapshot scoped to that agent's pane, and the hub the cancel is addressed to comes from that snapshot, never from the request. Without it the route would stop any task in any hub on the machine for anyone who could guess an id. `tasks.py` reuses the monitor plugin's own `adapter.py` — 0700 root, 0600 discovery and token files, a recomputed socket hash, lease expiry — rather than keeping a second copy of security-critical discovery code.

  Task fields pass an explicit allowlist (`ownerSessionId`, `ownerLeaseExpiresAt`, `checkoutId`, `workspaceId` and `hubPaneId` all stop at the backend), output is a bounded 2 KB tail per task with at most 8 socket reads per request, and — as everywhere else in this panel — no monitor, no pane, an unreachable socket and a hub that has spawned nothing are four different sentences and zero errors.

  Two tests that had been silently stranded by earlier refactors are fixed and wired into `npm test`: `monitor-publisher.test.ts` omitted `parentGeneration`, so the parent lookup failed and the assertion covering this very pane correlation had been red on a clean checkout; and `review-live-wiring.red.test.py` was asserting a bounded cancel response against the two-line re-export shim left behind when the socket server moved, proving only that the shim was short.

- 72ff5e1: Replace the Hermes fleet pane's ask box with a per-session modal, and make the panel read-only for now.

  Selecting a row used to fill in a composer at the bottom of the pane: an input, a Send button, and — squeezed into the header line next to it — the only other thing you could do, `Focus pane`. Sending is withdrawn for the moment, so what is left needed somewhere better than the bottom of a 300px column.

  A selected row now opens a modal. It carries what the row has to truncate — purpose, model, directory, context use, queue depth, uptime, heartbeat age, and which herdr pane hosts it — and below that the actions available on that agent, which for now is exactly `Focus pane`. An action that is currently impossible stays visible and disabled with the reason beside it, because "why can't I focus this one" is the question the panel exists to answer: a `detached` row is a live session that no pane hosts, which is a different statement from an agent that cannot be reached. A session that dies while its modal is open reads `gone` rather than emptying out, since the selection is re-found in each payload rather than remembered.

  `presentComposer()` is gone, replaced by `presentSessionMenu()` returning a list of actions — adding one is an entry in that list and a door in the renderer, not a new component. `POST /sessions/{project}/{name}/prompt` and the dispatch transcript behind it are untouched and still work; nothing in the pane calls them.

- 72ff5e1: Make a running fleet legible in the Hermes panel, and stop `started_at` from lying.

  Both harnesses rebuilt their coms registry entry on every 30-second heartbeat with `started_at: nowIso()`, so the field never held the start of anything — a session running for two hours reported an age of a few seconds, and anything trying to show uptime was showing noise. The entry is now built by `buildLiveRegistryEntry()` in `.pi/harnesses/lib/coms-registry-entry.ts`, shared by the standalone coms harness and the copy embedded in agent-hub: registration sets `started_at`, the heartbeat carries it forward and moves `heartbeat_at` instead.

  The `agent-fleet-herdr` panel forwards what it already had and derives what the renderer cannot. Rows now carry `uptime_s`, `heartbeat_age_s` and `stale` (the same 90s freshness rule the registry reader applies), plus `heartbeat_at` and the pane's `workspace_id`; the payload carries `herdr_panes`, the total pane count from herdr. All time arithmetic happens in the backend, which knows when the snapshot was collected — a `null` timestamp renders as nothing rather than `0s`.

  That pane count is what finally explains `detached`: "herdr reports no panes at all" and "none of 7 herdr panes reports it" are different problems that used to be the same word. A stopped heartbeat outranks both, because it is a statement about the process rather than about our view of it. Rows also show context use, a non-empty queue and uptime, and a pending dispatch counts up on its own second-by-second instead of looking identical from the moment it is sent to the moment it answers.

  New: `POST /sessions/{project}/{name}/focus` brings the workspace hosting a peer to the front. It takes `(project, name)` like the prompt endpoint, resolves the workspace server-side from a herdr answer taken now, and validates the id before it reaches argv. A `detached` peer answers 422 — it is still perfectly askable, since coms reaches its own socket, but there is no pane to bring forward.

- 72ff5e1: Make the fleet report its own transitions instead of being watched.

  The Hermes panel could tell you _that_ a session existed and, eventually, _that_ a prompt was answered. Anything in between you had to catch by looking. `hermes/plugins/agent-fleet-herdr/dashboard/watch.py` turns consecutive `/sessions` payloads into events — `needs_answer`, `unblocked`, `finished`, `vanished`, `stale`, `dispatch_answered`, `dispatch_failed` — and hands them to two sinks: a ring buffer the pane drains into toasts, and, only when a config file says so, `hermes send`.

  It is three layers on purpose. `diff_snapshots(prev, next)` is pure: no I/O, no clock of its own — time comes from the payload's `collected_at` — so every rule is testable from two hand-written fixtures. `Watcher` is the memory around it: a question must persist 20 seconds before it interrupts anyone, an identical event collapses for a minute, and past twelve events in a rolling minute a single `throttled` line says how many were dropped. Only `collect_snapshot` and the runner touch anything.

  Two rules earn their weight. A herdr outage is not fleet news: when herdr stops answering every row degrades to `unknown`, so that snapshot is discarded whole and the previous one kept — the fleet is not reported as having changed once going blind and once coming back, and whatever really happened is reported on recovery, against evidence. And a question answered inside the debounce suppresses _both_ its `needs_answer` and the `unblocked` that would have followed; announcing the end of something nobody was told about is exactly the noise this layer exists to remove.

  `GET /events?after=<seq>` is cursor-based, bounded to 200 and per gateway process, and returns `seq` even when the list is empty so a client that fell behind resumes from the present rather than replaying a truncated past. Every `/sessions` request feeds the watcher, and the first one starts a background thread that keeps snapshotting every 15s so closing the pane does not stop the watching; `python3 watch.py --daemon` runs it without a Desktop window, and `--snapshot` prints what the watcher sees.

  The Telegram sink ships default-off and does not exist unless `$HERMES_HOME/agent-fleet-watch.json` sets `telegram.enabled: true` with a target that survives validation. Target and profile are checked against a character class before they reach argv, `hermes send` is spawned as a list rather than a shell line, and sends run on their own thread behind a bounded queue so a slow subprocess can never hold up a `/sessions` request.

  In the pane, `needs_answer` is a sticky warning, `vanished` an error and the rest ambient; the toast id is `(kind, project, name)`, so an agent that flaps replaces its toast instead of stacking a column. The events poll deliberately does not pause on `visibilitychange` the way the list poll does — a hidden window is when a toast is worth raising — and its first answer only sets the cursor, so opening the pane never replays history as if it were live.

- 72ff5e1: Add the `agent-fleet-herdr` Hermes Desktop plugin: a read-only panel listing live Agent Fleet sessions grouped by coms project, joined to herdr pane state by peer name, surfacing the agents that are waiting for a human answer. Ships both halves (Electron pane + FastAPI backend), a shared `scripts/install-hermes-plugin.sh` installer, and `docs/hermes-desktop-plugins.md` describing the plugin contract and its failure modes.
- 72ff5e1: Fix herdr presence against herdr 0.7.4+ and let the Agent Fleet panel dispatch prompts.

  herdr 0.7.4 removed `custom_status` from `pane.report_metadata`, so every presence report had been failing silently — `HerdrPresence.report()` swallows errors — leaving every pane unannotated and every fleet view stuck on `detached`/`unknown`. Presence now writes herdr's `tokens` (`coms`, `proj`, `ctx`, `q`), negotiating the dialect by trying and latching rather than version sniffing, with an `onError` hook that both harnesses log to `coms-log` as `presence_dialect_rejected`.

  The Claude Code bridge (`scripts/coms-claude-bridge.ts`) had its own second copy of the annotation call and stayed on the removed `custom_status` field, so every bridged Claude peer read `detached` no matter what it was doing. It now goes through the shared `HerdrPresence.annotate()` — annotation only, never `pane.report_agent`, since the bridge polls that same `agent_status` back as its turn-completion signal.

  Because tokens carry the coms project, the `agent-fleet-herdr` join key is now `(project, name)` instead of `name` — two projects each running an `orchestrator` resolve to their own panes instead of both collapsing to `unknown`. A missing pane is reported as `detached`; `unknown` is now reserved for genuinely competing evidence.

  The panel gained an ask box: `POST /sessions/{project}/{name}/prompt` hands a coms prompt envelope to a live peer and shows the answer when it lands. The renderer names `(project, name)` only — the socket path is resolved server-side from a freshly re-read registry, so no endpoint reaches a file running with the app's full privileges.

- 72ff5e1: Put the Hermes Desktop fleet panel on the front page, and say plainly which subscriptions the fleet runs on.

  `agent-fleet-herdr` had a thorough runbook and no way in. It is now a first-page section of the README with its own install how-to, a `mermaid` diagram of what it reads, and screenshots of the panel and the session modal — plus the same install path in `docs/getting-started.md`, a two-integration table at the top of `hermes/README.md` (the Desktop panel reads the fleet; the question bridge lets the fleet ask you — easy to conflate, independent to run), and a runtime-layer row in `docs/ARCHITECTURE.md`.

  `docs/hermes-desktop-plugins.md` gains the part the runbook never had: **how it connects to Agent Fleet**. Four sources, each named with what it contributes and which module writes it — the coms registry (who exists, and the filter), herdr pane presence (what state), the agent's own transcript (what it is doing), the agent-hub monitor (which subagents are running) — and the two consequences that matter to an operator: nothing about launching a fleet changes, and the only write doors are `focus` and subagent `cancel`, both re-derived server-side. The Install section now leads with a prerequisites table, because "an empty panel" is the shared symptom of a missing prerequisite and of a correctly idle fleet.

  **Bring your own subscriptions — and your own GPUs** is a new README section. Mixing providers inside one fleet is the normal configuration here, not an edge case, and the README never said so: Codex/ChatGPT and GitHub Copilot subscriptions, a real Claude Code pane bridged in as a coms peer, Ollama cloud or local, and locally hosted weights for the always-on cheap roles. It is also the argument for cross-model review — a `builder` and a `code-reviewer` on different labs' models catch what one model rationalizes past — and for the three-tier ladder, where recon runs on your own hardware and only synthesis spends the expensive tier.

- 71f70af: Add an optional, profile-aware, fail-closed Hermes watchdog source and lifecycle tooling. Origin-chat delivery, steering, and surgical recovery remain disabled until genuine live Hermes capability evidence exists.

  The package also carries the backend and Desktop monitor plugin source as opt-in runtime source; nothing is installed, enabled, or launched by installing the package. `agent-fleet set-hermes-watchdog` gains receipt-based adoption of an identical unmanaged skill tree, and the local monitor contract adds `events` and `invoke` alongside the existing snapshot/output/cancel baseline, which is unchanged.

  Two local transport fixes: the monitor socket no longer drops a response that settles after a half-closing client's FIN, and the watchdog's long-poll read timeout now covers the wait window it requests instead of expiring early and journaling a false outage.

  Local runtime coverage exercises a real foreground watcher against a disposable Hub socket in observe mode. That evidence is synthetic-local: it proves neither Gate O, live origin delivery, steering, surgical execution, nor A6.

- 589d89f: Harden agent-hub against harness-level failures that presented as specialist failures.

  Session files: an unusable `<agentKey>.json` is now validated and quarantined to `<file>.corrupt-<ISO>` before any spawn, and a run that pi rejects for a session reason is retried exactly once from a clean session. The check is unconditional, because `--session` reaches pi on every run — so neither `team_adjust drop`/`add` nor `/af-agents-restart` could previously recover a corrupt file. Roster messages no longer promise a reusable session file that pi would refuse.

  Drift watchdog: the session's own `artifacts/`, `findings/`, and `delegations/` subtrees are implicitly in scope, since the deliverable protocol orders specialists to write there, and the judge prompt now says so. The `scope` rule is non-terminal — it reports a drift advisory on the dispatch result instead of stopping the run, matching the post-run scope gate, which reverts nothing. `loop`, `failures`, and `toolcap` stay terminal.

  Turn budget: input artifacts resolve before a dispatch is counted, and `spawn_research` validates its persona and artifacts before spending a research slot — a path typo no longer costs a budget slot. Artifact paths now resolve across artifact kinds when the basename is unique (the hub writes auto-returns under `returns/`, so `reviews/<x>-run1.md` used to fail), with the correction reported back to the dispatcher and an explicit refusal when two kinds match.

  Return contract: `ASSERTION A1: PASS — <evidence>` and the bare `A1: PASS` line forms are parsed, with a declared block always winning and an id the schema already classified never re-stated from a loose line. When nothing parses and assertions were tracked, one bounded read-only pass extracts the block from the report already on disk rather than declaring every assertion unproven; extracted returns are labelled as weaker evidence.

  coms bridge: a Claude Code pane that is mid-turn is now waited on with bounded backoff instead of failing immediately, and `coms_send` accepts `reply_timeout_ms`, which the bridge honours (clamped to one hour) instead of always applying its own default. That default rises from 10 to 30 minutes, matching `coms_await`. Wait-budget exhaustion returns `pending` rather than an error, writes no failure/return artifact, and preserves the original correlation so a late reply can still be collected without re-sending the task.

  Assertion ledger: every assertion must name its `source` (the plan line, user request, or finding it encodes) — a sourceless batch is refused by id, because a specialist told to prove `A9` previously had to spend a dispatch and an ASK_USER cycle asking where `A9` came from. Batches over 8 open assertions are accepted with a warning suggesting the split. The orchestrator persona documents both rules.

  Context accounting: each specialist and research helper is now measured against **its own** model's context window, resolved from pi's model registry with the source recorded, instead of against the dispatcher's window — which is why readings like "Planner context at 315%" were unactionable. A reading above 100% emits a one-time diagnostic naming the window and its source, a session at or past a full window is recycled unconditionally, and a resumed session whose projected prompt would overflow is recycled **before** the spawn rather than after 985s of billed work.

  Concurrency: requests to one provider are capped per process (default 2 in flight for `custom/*`, unlimited elsewhere, configurable via `AGENT_HUB_PROVIDER_LIMITS`, e.g. `custom=4` or `custom=off`). Queued children still run; a nested spawn reuses its parent's permit so it can never wait on its own ancestor. Read-only children (and research helpers) now retry once on their fallback model when the provider fails **mid-run** — previously only a pre-work failure was recoverable, so a local-endpoint OOM discarded the whole run. Write-capable children keep the strict rule, since a retry there could duplicate edits.

  Peer visibility: `coms_list` reports each peer's `pane_id` and `status` (`idle` | `working` | `booting`), so a sender can check addressability instead of screen-scraping the pane — the gap behind 127 `herdr_read_pane` calls in one session. `herdr_spawn_peer` waits (bounded) for the spawned peer to register and returns `peer_ready` with its coms name instead of only a pane id, and peers that were spawned but never sent to are named at turn end and in `/af-hub-report`; closing still requires the human's confirmation.

  Delivery failures: a run that errored or timed out writes its output to `artifacts/failures/<agentKey>-run<N>.md`, never `returns/`, and the dispatch result names it a delivery failure with no assertion evidence. A 142-byte coms error stub stored as a return previously cost a full dispatch investigating a review that had in fact succeeded — only its reply was lost.

## 0.0.6

### Patch Changes

- 9b81430: Namespace every Agent Fleet Pi slash command under `/af-*`, including lifecycle prompt templates, harness controls, utility-extension commands, and installer entrypoints. Pi bootstrap and guided setup migrate owned legacy prompt targets while preserving modified or unowned files.

## 0.0.5

### Patch Changes

- fb50bef: Add `/set-hermes-telegram` (`/af-set-hermes-telegram` on OpenCode) and the deterministic `agent-fleet set-hermes-telegram` CLI. It installs/status-checks the profile-scoped `hub-liaison` skill with drift protection, atomic backup/replacement, tool and gateway verification, and explicit restart control, then starts or stops the Telegram `ask_user` bridge in a dedicated pane in the current Herdr workspace. Bridge sends are pinned to the verified Hermes profile instead of relying on the sticky default.
- fb50bef: Add `just fleet` as the unified Pi runtime entry point. Fleet Core now guarantees Damage Control Continue, local/remote `ask_user`, Speech-to-Text, Compact & Continue, BTW, and update checks across the default session, Hub, standalone coms peers, and Herdr Pi peers. Add composable `peer`, `hub`, `team`, conductor, lifecycle, browser, and extension-discovery modes behind a single public Just recipe; the former Hub, team, coms, and conductor recipe aliases are removed.
- aa5630c: Fix symlinked Agent Hub launches after package-only updates. The hub monitor runtime now ships atomically under the shared harness library, and `ask-user-remote` canonicalizes its own package path before loading the bundled `pi-ask-user` dependency.
- d0e1914: Hoist MCP extension runtime dependencies into the published package so symlinked `chrome-devtools-mcp` peers can resolve the SDK from their real npm package path. Add package-surface regression coverage and strengthen setup/runtime verification guidance.

## 0.0.4

### Patch Changes

- ccefce7: Rework the guided-workspace-setup flow around the `pi-ask-user` widget: an Express question can resolve the whole install menu in one prompt, each group opens as a single-select quick screen with drill-in chunks only behind Customise, removal moves to an explicit "Remove some…" selection (the widget has no pre-checking), and every screen obeys a hard budget (≤ 9 options, ≤ 8 context lines) so nothing overflows the terminal. Doctor findings, overrides, method, and the confirm+installer-cleanup question all become native widget prompts; the old table format survives only as the no-widget fallback. The claude-code/opencode setup commands and doctor prompts mirror the same contract.
- b86362d: Fix fleet panes spawning with every pi provider "unconfigured": simultaneous pi boots race on the `~/.pi/agent/auth.json` file lock when the stored OAuth token is stale (the refresher holds the lock across its network call, and losers silently boot with an empty credential store). `team-up`, `hub-team`, and `team-resume` now pre-warm: when a stale OAuth credential is detected, one pi pane starts immediately to refresh the token and the other pi panes are staggered via `AGENT_FLEET_SPAWN_DELAY` (honored by the `_peer`/`_peer-plus` recipes). Fresh tokens spawn with zero delay; `claude-code` runner panes never wait.
- ac770c6: Add an experimental Linux Codex remote-control conductor: scoped and serialized `coms` delegation, a fail-closed conductor contract and wrapper rendered into an external user-state runtime workspace, typed Hermes/Codex team layouts, user-systemd lifecycle helpers, setup/package integration, and an operator runbook. This is intentionally a patch changeset to match the repository's forced-patch release policy.

  **Pilot upgrade:** rerun `conductor-codex-reconfigure` before the next start so the owned configuration/unit and managed contract move to the external user-state runtime directory.

  **Migration:** CLI spools now live at `~/.pi/coms/cli/projects/<project>/<name>/`. If an older name-only queue exists at `~/.pi/coms/cli/<name>/`, the CLI refuses queue operations until the operator stops that identity, inspects its pending/responses/inbound data, identifies the owning project, and moves the complete directory under the project-scoped path. Do not delete or merge ambiguous queues. The identity name `projects` is now reserved.

- 3503055: Show the root-stamped package version in persistent Pi harness footers, including agent-hub's custom footer, and keep the version deduplicated when supported harnesses are stacked.
- f44752f: Add the optional local Hermes task monitor source MVP, including an Agent Fleet-owned hub monitor boundary, Hermes backend adapter, and Desktop pane with manual installation guidance.
- 3503055: agent-hub: execution modes with enforced per-turn budgets, session recycling, and cheaper persona defaults — the fix for runaway over-orchestration (100+ dispatches / 100M+ tokens per task, mostly re-billed stale context).

  - **Execution modes** `fast` / `standard` (default) / `strict` with per-user-turn budgets enforced in code: `dispatch_agent` and `spawn_research` refuse past the cap with "summarize and ask the user"; a new user message opens a fresh window. New `/hub-mode` command, `hub-mode` status chip, and mode-aware dispatcher prompt (fast: single specialist, ledger optional; standard: batched builds, one recon, one review gate; strict: full Verification Contract).
  - **New overrides keys** under `## agent-hub`: `mode`, `max-dispatches-per-turn`, `max-research-per-turn`, `turn-wall-time-s`, `agent-turn-timeout-s`, `session-recycle-runs` (validated by `agent-fleet doctor`).
  - **Whole-run deadline** (`turn_timeout`, exit 124, partial output preserved) for dispatched specialists, research helpers, and nested delegate children — a hung child can no longer hold its parent for hours. Complements the per-tool `recon-search-timeout-s` watchdog.
  - **Session recycling + honest context measurement**: specialist context pressure now counts input + cacheRead + cacheWrite (previously cache reads were invisible, so the restart advice never fired); specialist sessions are recycled after N resumed runs or ≥60% measured context instead of resuming forever.
  - **Dispatch key normalization**: `dispatch_agent(agent: "Test Engineer")` resolves to `test-engineer` instead of erroring.
  - **Persona tuning**: orchestrator thinking xhigh→medium, builder/code-reviewer high→medium, plan-reviewer Sol→Terra + medium, test-engineer medium→low with scouts on Spark and the delegation pre-pass now conditional (first dispatch in an area only); orchestrator posture rewritten for batched execution (4–6 tasks per builder dispatch, narrow assertions, no researcher spawns to read return artifacts, "two reads" and deep research reserved for strict mode).

  Existing behavior is restored with `mode: strict` in `.ai/agent-fleet-overrides.md`.

- 3503055: agent-hub: complexity triage, in-flight drift watchdog, dynamic teams, and per-turn cost reporting — the qualitative follow-up to the execution-modes/budgets guardrails (stop over-engineering simple asks and catch drifting specialists while they run, not after).

  - **Task triage**: new `set_task_tier` dispatcher tool (`trivial`/`small`/`feature`/`project`); enforced caps drop to min(mode, tier) — a trivial ask gets 1 dispatch, not the whole standard envelope. The system prompt mandates triage-first, treats a provided plan as a spec (no re-planning/re-spec), calls out "using every persona" as a smell, and requires a four-part task template (objective, output format, files in scope, boundaries). A **duplicate-dispatch guard** refuses re-dispatching the same agent with a near-identical task within one turn (in code, `duplicate_refused`).
  - **Drift watchdog** (`drift-watchdog.js` + a new `onControl`/`drift_stop` seam in `spawn.ts`): armed dispatches are observed live from the tool event stream — deterministic rules (write outside the declared `scope` globs, identical call repeated 4×, 5 consecutive failed tool calls, 200-call cap) escalate to a one-shot cheap LLM judge (single-flight, 90 s cooldown, fails open; model via `watchdog-judge-model`, default researcher persona's). A DRIFTING/STUCK verdict terminates the run as `drift_stop` (exit 125, partial output preserved) with a corrected-re-dispatch-once instruction. Dynamically enabled per dispatch (`watchdog` param) > per agent (`/watchdog <agent> on|off|clear`) > hub-wide (`/watchdog on|off|auto`, overrides key `watchdog`, default `auto`).
  - **Dynamic teams**: `/agents-add`, `/agents-drop` (refuses running/last members), `/agents-save <team>` (targeted comment-preserving upsert into `.pi/agents/teams.yaml`), and a gated `team_adjust` dispatcher tool (reason required, off in fast mode, roster cap 8, human notified). The dispatcher prompt rebuilds every turn, so roster changes apply immediately.
  - **`/hub-report`**: per-turn and session cost accounting — dispatches (agent/status/elapsed/billed+output tokens), research runs, session recycles, drift stops, budget/duplicate refusals. The `hub-mode` status chip now shows the declared tier.
  - New overrides keys `watchdog`, `watchdog-judge-model` validated by `agent-fleet doctor`; orchestrator persona gains triage-first and plan-is-a-spec posture.

- c0701f6: Add `pi.image` gallery metadata so the pi.dev/packages listing shows the agent-hub dashboard screenshot as a preview
- 7a92825: Document the `--project` flag on every team recipe in the justfile and the README quickstart: scoping a team to its own coms pool (`just hub-team review --project af`) is what keeps teams launched from different repos out of each other's peer pool, and the bare `project=af` form is a just variable override that gets silently ignored (the team lands in the shared "default" pool and collides with other repos' peers — name suffixing like `code-reviewer2`, dispatches routed to the wrong repo's pane).
- 4037b36: README simplified into a landing page (676 → ~220 lines) — the hero screenshot and Quick Start (pi first) moved to the top, and the reference depth relocated with links instead of deleted:

  - Full 29-skill tables → new `docs/skills-catalog.md` (now also listing `designing-agents` and `guided-workspace-setup`, so the count is honest).
  - Full 15-persona roster, skill hooks, install matrix, and team composition → `docs/agents.md` (which previously pointed back at the README).
  - Fleet hierarchy diagrams, runtime-stack diagram, and the external-dependencies ("Built on") table → `docs/ARCHITECTURE.md`.
  - The end-to-end dispatch sequence diagram → the agent-hub harness README; its stale design-plan link fixed to `docs/plans/agent-hub/`.
  - Origins condensed into Credits; a new Documentation index section links every guide.

- ae57f1c: agent-hub: research helpers no longer pile up after finishing, and the research/team command families are unified. Finished helpers are auto-pruned — auto-research pipe helpers (spawned for `NEEDS_RESEARCH:` pauses) disappear as soon as they finish since their findings persist as `findings/*.md` files, while manual/persona helpers keep only the most recently finished N (new `research-keep: <n>|all` key in the `## agent-hub` overrides section, default 4, LRU by finish time). Running helpers are never pruned and `rN` handles are never reused; `/agents-history` keeps its full timeline. The `agents-*` slash commands now address both target kinds the way `/zoom` already did: `/agents-kill <name|rN|all>` SIGTERMs a team specialist (its standing card stays), while on a research helper it kills **and removes** the card + session file — helpers are disposable by design — with `all` clearing every helper; `/agents-restart <name|rN>` accepts research handles (finished helpers re-run fresh); and a new `/agents-cont rN <prompt>` resumes a finished helper — `/research-cont`, `/research-rm`, and `/research-clear` remain as aliases. Retention selection lives in a new tested pure module (`research-retention.js`).
- 99759a2: Retire the hard-stop `.pi/harnesses/damage-control/` artifact and `just ext-damage-control` recipe. `damage-control-continue` is now the only supported safety harness and guards the Agent Hub dispatcher, native specialists, research helpers, and nested delegates. Protected deletions require explicit one-call approval, inherently dangerous command patterns remain non-exemptible, and missing child safety fails closed. Guided setup removes only owned, unchanged legacy hard-stop installs and preserves user-modified or unowned copies.
- 2613096: First-class symlink installs: remembered method, kept installer, symlink-safe script runs.

  - `guided-workspace-setup` now reuses the `method:` recorded in `.ai/agent-fleet-setup.md` instead of re-asking copy vs symlink on every run (asked only on first install; overridable in the Step 9 summary), and a recorded `keep-installer: true` skips the installer-removal offer entirely — the summary just confirms the commands stay.
  - The `justfile` runs the fleet TS scripts through a `node_ts` variable that adds `--preserve-symlinks --preserve-symlinks-main`. Without them, a symlink install (targets linked into the project-scoped `.pi/npm/node_modules/@chankov/agent-fleet` package) breaks: Node realpaths `scripts/*.ts` into `node_modules/`, where `--experimental-strip-types` is refused. Copy installs are unaffected — the fleet scripts import only relative paths and node builtins.

- 3e6b05f: Harden the ask-user-remote harness against a double-load of the stock `pi-ask-user` extension. When `npm:pi-ask-user` was also listed in pi settings `packages`, a load-order race could hard-crash the session (`Tool "ask_user" conflicts`) if the harness registered its wrapper first. The harness now runs a startup preflight over project (`.pi/settings.json`) and global (`~/.pi/agent/settings.json`) settings: if a `pi-ask-user` package entry is found, it warns and skips registering the wrapper so the stock package registers alone — the session survives regardless of load order (remote answer racing is disabled until the entry is removed). The repo's own `.pi/settings.json` no longer lists `npm:pi-ask-user`.
- 76b33a9: Scope herdr team workspace labels to the checkout so the same team can run from multiple repos/worktrees at once. Previously `just hub-team <team>` always labeled its workspace `pi-hub-<team>`, so launching the same team from a second repo/worktree failed with `herdr workspace "pi-hub-<team>" already exists`. Labels are now `<worktree-tag>-<mode>-<team>` (e.g. `wt2-hub-plan`, `end2-peers-docs`), where the worktree tag is the last dot-segment of the checkout directory's basename (`main.wt2` → `wt2`, `ringithub.end2` → `end2`, a plain `agent-fleet` checkout → `agent-fleet`). `team-up`, `hub-team`, `conductor`, and `team-snapshot`/`team-down`/`team-resume` all derive the tag the same way, so snapshot/resume still target the workspace they created. The `--project <name>` flag remains a separate axis for coms-pool scoping.

All notable changes to `@chankov/agent-fleet` are documented here. Agent Fleet
starts at 0.0.1; earlier `@chankov/agent-skills` releases remain available in
git history. This file is generated from [changesets](https://github.com/changesets/changesets).

## 0.0.1

### Patch Changes

- 1b864df: Agent Fleet split: standalone repository, vendored upstream skills, full rebrand.

  - Repository split from the `agent-skills` fork into standalone `chankov/agent-fleet` with filtered history; upstream `addyosmani/agent-skills` is now consumed as manually vendored content in `vendor/agent-skills-upstream/` at a pinned SHA (see `docs/UPSTREAM-SKILLS.md`).
  - Package renamed `@chankov/agent-skills` → `@chankov/agent-fleet`; CLI bin `agent-skills` → `agent-fleet` (no alias); commands `/setup-agent-skills` → `/setup-agent-fleet`, `/doctor-agent-skills` → `/doctor-agent-fleet`; OpenCode prefix `as-*` → `af-*`; install record `.ai/agent-skills-setup.md` → `.ai/agent-fleet-setup.md`; overrides file `.ai/agent-skills-overrides.md` → `.ai/agent-fleet-overrides.md`; update-check extension renamed `agent-fleet-update-check`.
  - Skill discovery now spans two roots (native `skills/` wins over the vendored import on name collisions) across pi packaging, the guided setup, the doctor scan, and the Claude Code plugin manifest.
  - `FORK.md` retired; replaced by `docs/ARCHITECTURE.md`, `docs/UPSTREAM-SKILLS.md`, and `docs/MIGRATION-agent-fleet.md`.
  - Workspaces installed by `@chankov/agent-skills` are not auto-detected — re-run `npx @chankov/agent-fleet init`.

- 7d41b14: Fix the `bowser` browser-automation persona/skill so it actually resolves and document its external CLI dependency.

  - **Naming fixed** — `agents/bowser.md` referenced a skill named `playwright-bowser`, but the runtime skill is `.pi/skills/bowser/` (`name: bowser`), so the persona's skill hook never resolved. The persona now references the `bowser` skill, and its workflow runs `playwright-cli` commands (not the non-existent `playwright-bowser` command). The `transform-persona.js` pi-only comment is updated to match.
  - **External dependency documented** — the skill drives the external **Playwright Agent CLI** (`playwright-cli`), which is not bundled. `.pi/skills/bowser/SKILL.md` gains a Requirements section with the install commands (`npm install -g @playwright/cli@latest`) and a link to <https://playwright.dev/agent-cli/installation>; `docs/pi-extensions.md` notes the same.
  - **Guided setup maintains it** — when the `bowser` runtime-skill is selected, `guided-workspace-setup` now checks for `playwright-cli` on PATH and offers the install (treated as an external dependency, like `pi-ask-user`), with matching Red Flag and Verification entries.
  - **Broken link removed** — `SKILL.md` no longer points at a non-existent `docs/playwright-cli.md`; workflow step numbering corrected.

- 39b8bf4: Polish the browser-persona division:

  - `test-engineer` now states it owns test _code_ and hands off live-browser runtime-UI proof to `bowser` (headless) or `web-debugger` (interactive).
  - `bowser` gains an explicit `tools: read,bash` whitelist (it only needs Bash for `playwright-cli` plus read for outputs).
  - `guided-workspace-setup` notes that `bowser` and `chrome-devtools-mcp` are two complementary browser stacks and recommends both for full coverage.

- d9a4e3e: Document the division between the two pi browser stacks and align the orchestrator's runtime-UI guidance.

  - New "Two browser stacks — when to use which" decision section in `docs/pi-extensions.md` (policy + why `web-debugger` is a coms peer, not a subagent).
  - The `orchestrator` persona now routes `runtime-ui` proof by mode: delegate a `bowser` subagent for headless evidence, or hand off to the `web-debugger` coms peer for interactive headful Chrome.
  - Cross-reference notes added between `.pi/skills/bowser/SKILL.md`, `skills/browser-testing-with-devtools/SKILL.md`, and the `chrome-devtools-mcp` extension README.

- dbb3661: Make the `chrome-devtools-mcp` pi extension mode-configurable via env vars, so the always-on browser stack covers both headless and headful use:

  - `PI_CHROME_DEVTOOLS_MODE=headless|headed` (default headed) — adds `--headless` for background/CI runs.
  - `PI_CHROME_DEVTOOLS_BROWSER_URL` — attach to an already-running Chrome via `--browserUrl` instead of launching one.
  - `PI_CHROME_DEVTOOLS_USER_DATA_DIR` — use a persistent Chrome profile (`--userDataDir`), mutually exclusive with the default ephemeral `--isolated` profile.

  The default launch is unchanged (headed, isolated). Because the MCP server starts once at extension load, changing these requires a pi restart / `/reload`. Documented in the extension README and `docs/pi-extensions.md`.

- 0cb88c2: agent-hub: dashboard cards now list running delegate children ahead of finished ones. Previously children rendered in spawn order and the `MAX_CHILD_ROWS` cap could hide live sub-agents behind already-completed ones; running delegates now sort first (spawn order breaks ties within each group) so an in-progress child is never the row that gets dropped.
- 0cb88c2: release tooling: every version bump is now forced to a patch (x.y.Z+1). A new `bin/force-patch-changesets.js` rewrites any pending `minor`/`major` changeset to `patch` and runs ahead of `changeset version` in both the local `version:changeset` npm script and the CI release workflow, so local and CI releases agree. The release command also synchronizes `package-lock.json` and writes the bumped version's tracked `.versions/<version>/` snapshot. Run releases with `npm run version:changeset` (not `npm version patch`, which bypasses the changeset flow).
- 67cb274: Add the **Verification Contract** to the agent-hub orchestration flow, so a clearly stated requirement (e.g. "Retired/Disqualified behave like Walkover") cannot be silently dropped across a multi-agent run. The dispatcher now owns checkable acceptance assertions and refuses "done" until each is proven with evidence.

  - **New skill `orchestration-verification`** — the single canonical source for the acceptance-assertion format (numbered `A1…`, tagged `test` / `runtime-ui` / `code-grep` / `manual`), the parity/touchpoint inventory for "make X behave like Y" requests, the structured upward-return schema, and the requirement-regression reset. Added to the `using-agent-skills` discovery tree.
  - **One orchestrator persona (breaking).** `orchestrator` and `orchestrator-careful` are consolidated into a single `orchestrator` that carries the careful (correctness-first) posture as its default and layers the Verification Contract on top — it builds the assertion list first, commissions a deep-researcher parity inventory, gates vertical micro-slices, requires runtime proof for UI/visibility/placement assertions, accepts only structured returns, and resets assertions on "wrong again". `orchestrator-careful` is **retired** (the pi-only persona roster drops from 14 to 13); its review-first behaviour is preserved in the surviving persona.
  - **Specialists report assertion status, not a verdict.** `builder`, `test-engineer`, and `code-reviewer` adopt the structured return; the reviewer gains a parity/generalisation review axis plus a runtime-proof-required rule for UI findings; the test-engineer gains a parity-coverage rule; the delegate children (`recon`, `verifier`, coverage scouts, `quality`/`perf`) are aligned to consume the dispatcher's parity inventory and report in assertion terms (frontmatter, budgets, and `delegate_depth` unchanged).
  - **agent-hub harness** — new always-on `set_assertions` / `update_assertion` / `get_assertions` dispatcher tools persist the ledger to `.pi/agent-sessions/assertions.json` (wiped at session start like `findings/`) and render a one-line status, keeping the contract out of the dispatcher LLM context. `get_assertions` is the bounded read-only recovery path: after a compaction the status line shows only counts, so the dispatcher reads the full ledger (ids, tags, pass conditions, evidence) back before re-dispatching. Advisory in this phase: status is surfaced and "proven" requires named evidence, but a dispatch is never hard-refused on an unproven assertion.
  - **claude-code & opencode `/orchestrate`** — both commands now carry the instruction-level Verification Contract (assertions built first, parity inventory for "behave like X", runtime proof for UI assertions, structured assertion-status returns, regression reset on "wrong again") and report proven/unproven assertions rather than a bare "verified", closing the gap where the non-pi flows could report done on the old acceptance behaviour.
  - **Guided setup now offers `orchestration-verification`.** The skill ships in the npm tarball (covered by the `skills/` allowlist) but was missing from the `guided-workspace-setup` install menu, so it was never installed even on "Everything" — it is now an `★`-recommended row in a new _Orchestrate_ sub-group, recommended whenever a persona that reads it (`builder`/`test-engineer`/`code-reviewer`) or the `orchestrate` command is selected. Documented in the README ("All 21 Skills" + an _Orchestrate_ section) and the CLAUDE.md Skills-by-Phase map.
  - **`just hub` loads the `orchestrator` persona by default.** Both `hub` and `hub-solo` now append `agents/orchestrator.md` as the dispatcher system prompt (only when the file is installed, so the hub still launches without it); override with your own `--system-prompt <persona>.md`.
  - **Verification/comms hardening phases 1-2.** agent-hub now machine-parses structured returns, persists assertion-carrying raw outputs under `.pi/agent-sessions/artifacts/returns/`, reports compact `structuredReturn`/`returnPath`/`contractNotices` digests, and adds an artifact bus (`returns`, `plans`, `reviews`, `inventories`, `evidence`) with validated path-only handoffs for `dispatch_agent` and `spawn_research`.
  - **Verification/comms hardening phases 3-4.** `dispatch_agent` can now carry advisory `scope` globs for writable specialists, reporting out-of-scope git changes without blocking or reverting, and delegate child results now write full output to result files while returning only compact `DIGEST:` summaries plus paths to the parent.
  - **Verification/comms hardening phases 5-7.** `update_assertion(status: "proven")` now validates tag-specific evidence (including runtime-ui artifact paths), `/handoff` machine-appends the verbatim verification ledger plus artifact index after the LLM brief, and team specialist context pressure now renders at 70% with a restart hint but no automatic restart.
  - **Verification/comms hardening fixes.** Align artifact write paths with session artifact resolution, restrict runtime-ui proof to session evidence artifacts, guard handoff machine appendices with a matching token, and harden structured-return parsing so assertion IDs inside evidence or non-assertion lists do not corrupt parsed entries.

- 57078cd: Add a `web-debugger` agent persona for interactive headful Chrome debugging via the `chrome-devtools-mcp` extension, plus the coms-peer plumbing to run it.

  - **New persona** `agents/web-debugger.md` — drives the live `chrome_devtools__*` tools (DOM snapshot, console, network, performance traces) for runtime-UI verification with a human in the loop. It is the interactive counterpart to `bowser` (headless `playwright-cli` automation): `bowser` is delegatable to a `--no-extensions` subagent, while `web-debugger` runs as a coms peer that loads the extension. Reads the `browser-testing-with-devtools` skill. Marked pi-only.
  - **Peer plumbing** — `peers.yaml` peer entries gain an optional `extensions:` field; `team-up.ts` routes such peers through a new `just _peer-plus <extensions> …` recipe that loads the named `.pi/extensions/` into the peer process alongside coms + compact-and-continue. The `web-debugger` peer is wired into the `full` and `web` teams.
