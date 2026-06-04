---
name: guided-workspace-setup
description: Guides installation of agent-skills artifacts into a target workspace. Use when onboarding a project to agent-skills, when installing skills, commands, prompts, personas, or pi extensions for a chosen coding agent, or when a workspace needs its setup files configured.
---

# Guided Workspace Setup

## Overview

This skill installs and configures agent-skills artifacts — skills, agent personas, commands or prompts, pi extensions and harnesses, references, and hooks — into a target workspace for a chosen coding agent. It runs interactively, writes project overrides to the target's `.ai/agent-skills-overrides.md`, records what it installed in `.ai/agent-skills-setup.md`, and can be re-run on the same workspace to add, update, or remove artifacts.

## When to Use

- Onboarding a new project or workspace to agent-skills
- Installing or changing which skills, commands, or personas a workspace uses
- Re-running setup to add, update, or remove already-installed artifacts
- Configuring a workspace's `.ai/agent-skills-overrides.md`

**NOT for:** authoring new skills or personas (use `designing-sub-agents`); editing artifacts inside the agent-skills repo itself; general context or rules-file tuning (use `context-engineering`).

## The Workflow

This skill is run from the agent-skills repo with the target coding agent active, and invoked with a path to the workspace to configure. Steps are gated — nothing is written to the target workspace until the user confirms in Step 9 — with **one explicit exception**: the `pi-ask-user` bootstrap in Step 5b. When the agent is `pi` and that interaction package is missing, the skill (after its own confirmation) installs it *before* the install menu and asks the user to reload and re-run, so the rest of setup can drive a native multi-select widget instead of a text fallback.

It maintains two files in the target's `.ai/` directory: `agent-skills-overrides.md` holds the minimal per-reader overrides that skills and the `agent-hub` harness read on every run/session start, and `agent-skills-setup.md` holds the install record this skill itself reads on re-runs. The overrides file stays small; the install record absorbs the bulk.

### 1. Detect interaction capability

Determine which interaction mode this runtime supports, in order of preference:

- **Native multi-select widget** (e.g. a runtime that renders true checkbox lists) — use it for every group in Step 6. On `pi`, this widget is provided by the external `pi-ask-user` package; when it is absent, Step 5b bootstraps it first (install → reload → re-run) so this mode becomes available on the second pass. On `claude-code` and `opencode`, the runtime supplies the widget directly.
- **`AskUserQuestion` with `multiSelect: true`** — usable when a group has ≤ 4 options, since the tool caps options at 4. Larger groups fall back to the next mode.
- **Tabular fallback** — print the group table (Step 6 format) and ask the user to reply with the picks. Always accept the shortcuts `all`, `recommended`, `none`, or a comma-separated list of item names/numbers.

Because the groups in Step 6 are large (the Skills group alone holds ~20 items), a true checkbox widget matters: on `pi`, prefer bootstrapping `pi-ask-user` (Step 5b) over falling straight to the tabular fallback.

### 2. Resolve inputs

Resolve four things. Accept any already supplied in the invocation (the `npx @chankov/agent-skills init` CLI passes the first three as flags); otherwise ask.

- **Source root** — the agent-skills package. **Resolution priority (use the first that works; never fall through silently):**

  1. **Bootstrap marker** — read `<workspace>/.ai/.agent-skills-bootstrap.json` if present. Its `sourceRoot` field is authoritative; the CLI wrote it during `init` and it points at the exact package the user's install came from (npm cache, global install, or symlinked clone). Verify the path still exists and contains a `package.json` whose `name` is `@chankov/agent-skills`; if so, use it and **stop**. If the path no longer exists (e.g. npx cache was cleaned), warn the user and continue to step 2.
  2. **SKILL.md realpath** — only if the marker is missing. If this `SKILL.md` is a symlink, follow it with `readlink`/`realpath` and use the resolved package root. **Do not** use the SKILL.md's *workspace* location (e.g. `.pi/skills/guided-workspace-setup/`) — bootstrap copies the file there, so that path is the workspace, not the source. The realpath only helps in symlink mode.
  3. **Ask the user explicitly.** Print: *"Source root not found. Run `npx @chankov/agent-skills@latest init` to bootstrap, or paste an absolute path to the package."* Verify the answer is a directory whose `package.json#name` is `@chankov/agent-skills`. **Do not scan the user's filesystem** for other agent-skills repos — that is invasive and produces wrong answers (it will pick up dev clones, forks, or stale copies).

  The install record's `## install-status` may *also* mention an older source root from a previous setup pass; ignore it for resolution. The bootstrap marker overrides it because it reflects what the user just ran. Note the divergence in the Step 9 summary so the user sees the change.

- **Workspace path** — the target project to configure. Confirm the path exists and is a directory; stop and ask again if it does not.
- **Coding agent** — `claude-code`, `opencode`, or `pi`. Detect the running agent from the runtime, show it to the user, and let them choose a different one.
- **Package version** — read `version` from the source root's `package.json`. This is the version that will be stamped into the install record in Step 10, and the right-hand side of every version-aware diff in Step 6.

### 3. Read the agent's setup conventions

For `opencode` and `pi`, read `docs/<agent>-setup.md` in the source root and follow the install locations and format it documents. For `claude-code`, use the built-in target map below. When the `*-setup.md` doc and the built-in map disagree, the doc wins.

Target map, relative to the workspace root:

| Artifact | claude-code | opencode | pi |
|---|---|---|---|
| Skills | `.claude/skills/<name>/` | per `docs/opencode-setup.md` | `.pi/skills/<name>/` |
| Personas | `.claude/agents/<name>.md` | per `docs/opencode-setup.md` | `agents/<name>.md` |
| Commands / prompts | `.claude/commands/<name>.md` | `.opencode/commands/as-<name>.md` | `.pi/prompts/<name>.md` |
| References | `.claude/references/<name>.md` | per `docs/opencode-setup.md` | per `docs/pi-setup.md` |
| Hooks | `.claude/hooks/<name>`, registered in `.claude/settings.json` | per `docs/opencode-setup.md` | per `docs/pi-setup.md` |
| pi extensions | — | — | `.pi/extensions/<name>/` |
| pi harnesses | — | — | `.pi/harnesses/<name>/` |
| pi harness support | — | — | `justfile` (agent-skills managed region), `scripts/*.ts`, `.pi/agents/*.yaml`, `.pi/damage-control-rules.yaml`, `.pi/harnesses/package.json` |

The **pi harness support** row is not a menu group of its own — it is the set of shared files the harnesses need in order to launch (the `justfile` recipes, the `team-up`/`coms-net` scripts, the peer/team YAML, the damage-control rules, and the harness `package.json` of runtime deps). These travel **with** the pi harnesses group (Step 6, group 6): whenever any harness is installed, refreshed, or removed, this support set is refreshed from source in the same pass. The `justfile` specifically is refreshed from the **current** source, so retired-harness recipes are pruned and new-harness recipes added automatically — see Step 6 and Step 10 for the merge and removal rules.

When neither the built-in map nor the agent's `*-setup.md` defines a path for a selected artifact, ask the user instead of guessing.

### 4. Analyse the workspace

Scan the workspace to ground the recommendations and the overrides offer:

- Language, framework, and package manager (`package.json`, `go.mod`, `pyproject.toml`, …)
- Test runner and dev-server command, where discoverable
- Git presence and current branch
- Existing agent directories (`.claude/`, `.opencode/`, `.pi/`)
- Existing `.ai/agent-skills-setup.md` — read its `## install-status` section to learn what is already installed, **and the `version:` line in `## workspace-summary` to learn which package version performed the install**
- An existing `.ai/agent-skills-setup.md` (or any populated agent directory) means this workspace has prior state — flag it for Step 5

**Version delta.** Compare the recorded `version:` against the package version from Step 2:

- Missing `version:` → workspace is **pre-versioning**. Prompt the user: "This workspace was set up before agent-skills used semver. Stamp it as `v<current>` (assume installed copies match the current source), or wipe and reinstall?" Do not run the three-way diff for pre-versioning workspaces — there is no recorded baseline.
- Recorded `version:` equals current → no version-driven menu changes; Step 6 only surfaces content-level drift.
- Recorded `version:` differs from current → load `CHANGELOG.md` between the two versions, and load the `.versions/<recorded>/` snapshot from the source root. Both feed Step 6.

Report a short summary of the findings before continuing.

### 5. Doctor preflight (existing setup only)

If Step 4 found prior state — `.ai/agent-skills-setup.md` exists **or** any of the install-target directories already contains skills/personas/commands — run the Doctor scan now, **before** showing the install menu. A fresh workspace skips this step.

Walk every install-target directory the chosen agent uses and look for **broken symlinks** — links whose source has been moved, renamed, or deleted. Directories to check, when present:

- `agents/` (and its `pi-pi/` subdirectory), `.claude/agents/`, `.opencode/agents/`, `.codex/agents/`, `.gemini/agents/`, `.github/agents/`, `.pi/agents/`
- `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`
- `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`
- `.claude/references/`, `.claude/hooks/`

For each broken link discovered:

1. Resolve where the link **was** pointing (`readlink`) and look up the canonical replacement in the source `agents/` or `skills/` tree — many breakages are stale names from the pre-merge layout (e.g. `reviewer` → `code-reviewer`, `red-team` → `security-auditor`).
2. If a canonical replacement exists, offer to repoint the symlink to it.
3. If no replacement exists, offer to delete the broken link.
4. Never overwrite a regular file you find at a target path — only act on symlinks whose target is missing.

Also flag any YAML configs (`teams.yaml`, `peers.yaml`) that still reference removed persona names, and offer to rename the references to the canonical name.

Present findings in a single table (keep it narrow — same widget constraint as Step 6/9: short `Issue`/`Fix` phrases, paths relative to the workspace, no overflowing cells):

| # | Path | Issue | Fix |
|---|---|---|---|
| 1 | `.claude/agents/reviewer.md` | broken link → missing `reviewer.md` | repoint → `code-reviewer.md` |
| 2 | `.pi/agents/red-team.md` | broken link, no replacement | delete |
| 3 | `.pi/agents/teams.yaml` | refs `red-team` | rename → `security-auditor` |

Then ask, multi-select: which fixes to apply now. Apply only the picked ones; record skipped items so the install menu can surface them again. Append a `## doctor-runs` line to `.ai/agent-skills-setup.md` with the date, agent, phase (`preflight`), and `repaired` / `deleted` / `skipped` counts.

The doctor scan is also exposed standalone as `/doctor-agent-skills` — running it outside a setup pass is this same scan-and-repair flow without the rest of the install menu.

### 5b. Bootstrap `pi-ask-user` first (pi only)

**Skip this step entirely unless the agent is `pi`.** For `claude-code` and `opencode`, the runtime already supplies a multi-select widget — go straight to Step 6.

For `pi`, the native multi-select widget comes from the external `pi-ask-user` package. The Step 6 groups are large (the Skills group alone is ~20 rows), so driving them through the tabular fallback is clumsy. The fix is to install the interaction tool *before* the menu, then re-enter setup once it is loaded.

From the Step 4 analysis, determine whether `pi-ask-user` is already available:

- **Available** — bundled by `@chankov/agent-skills`, recorded as a project package in `.pi/settings.json` / `pi list`, or provided globally by user settings. Then this step is a no-op: note "interaction widget present" and proceed to Step 6, which will use the native widget.
- **Not available** — do the bootstrap:
  1. Tell the user what is about to happen and why: *"`pi` renders the setup menu best with the `pi-ask-user` widget. I'll install it project-scoped, then you reload and re-run setup so the rest of the menu uses real checkboxes."*
  2. Ask for confirmation (this is the one pre-Step-9 write, per the gating exception). If declined, fall back to the tabular mode and continue to Step 6 in this same pass — do **not** force the install.
  3. On confirm, run `pi install -l npm:pi-ask-user` (project-scoped). Mention `pi install npm:pi-ask-user` only if the user explicitly wants a global pin.
  4. Record the package under the `external-pi-packages` / `project-packages` line in `.ai/agent-skills-setup.md` (same convention as Step 6's external-package handling) — do not copy files from `node_modules`.
  5. **Stop the pass here.** Print: *"`pi-ask-user` installed. Reload pi (restart the session or `/reload`), then re-run `/setup-agent-skills` — the menu will then use native multi-select. Nothing else has been written to your workspace."* Do not continue to Step 6 on this pass: the tool only becomes callable after the reload.

On the **re-run**, Step 4 finds `pi-ask-user` installed, this step is a no-op, and Step 6 renders every group as a true checkbox widget. In Step 6's External-pi-packages group, the already-installed `pi-ask-user` simply shows `installed · project package` and is pre-checked to keep — the bootstrap is not repeated.

### 6. Present the install menu

Offer every installable artifact, split into the groups below. **Each group is its own multi-select prompt** so the user picks one screen at a time. The groups are deliberately broad — 7 total (4 shared + 3 pi-only), so a non-`pi` workspace sees only 4 screens. Several groups bundle more than one artifact type; within such a group, a leading `Group` column labels the sub-category and rows are ordered by it so the table still reads as labeled sections. Render every group's items as a markdown table using this fixed format:

| Pick | Item | Group | St | Purpose |
|---|---|---|---|---|
| `[x]` / `[ ]` | `<name>` (append ` ★` when recommended) | sub-category (see each group) — omit the column for single-type groups | short status token (see legend) | one-line purpose, ≤ ~6 words |

**Keep it narrow.** The `pi-ask-user` widget renders the table at fixed column widths, so wide cells force horizontal overflow — the user then has to zoom out, which makes the widget re-render and flicker. Render compact so the whole table fits a standard terminal width:

- Use the short `St` token, never the long state name. Print the legend once, on a single line above the table: `St: ok=up to date · upd=update available · mod=modified locally · cflt=conflicting upgrade · gone=removed upstream · new=new this version · pkg=project package · — =not installed · brk=broken`.
- Fold the recommendation mark into `Item` (append ` ★`) — do **not** add a separate `Rec` column.
- Keep `Purpose` to a short phrase (truncate with `…` if needed); keep `Group` labels short (`UI`, `focus`, `safety`, `orch`, `msg`, `ext`, `skill`, `ref`, `hook`, `rw`, `ro`).
- Keep the context preamble and the after-table prompt to short single lines — no multi-clause sentences that overflow the terminal.

**Pre-selection rule.** The `Pick` column is pre-ticked from the workspace's current state — not from preference. Every item is either pre-checked `[x]` (touched if confirmed) or pre-unchecked `[ ]` (left alone if confirmed):

| Current state | `St` token | Pre-check | What confirming will do |
|---|---|---|---|
| `installed · up to date` | `ok` | `[x]` | no-op (kept as-is) |
| `installed · outdated` (source newer than the installed copy; copy-mode only) | `upd` | `[x]` | refresh to current source |
| `installed · modified` (target diverged from source) | `mod` | `[x]` | refresh from source — **local edits will be overwritten**; untick to preserve them |
| `installed · upgrade available` (recorded version != current; user copy still matches the recorded-version source) | `upd` | `[x]` | clean refresh to the current-version source |
| `installed · conflicting upgrade` (recorded version != current; user modified the copy AND source changed upstream) | `cflt` | `[ ]` | nothing — show the three-way diff (recorded vs installed vs current) inline and ask before any write; tick only after the user accepts the overwrite |
| `installed · removed upstream` (artifact gone in the current version) | `gone` | `[x]` | propose deletion in Step 10 (subject to the removal-scope rule); untick to keep the local copy |
| `not installed` | `—` | `[ ]` | nothing — unless the user ticks it to install |
| `not installed · new in this version` (artifact added between recorded and current) | `new` | `[ ]` | nothing — unless the user ticks it; marked `★` if recommended |
| `broken · skipped in preflight` (carried over from Step 5) | `brk` | `[ ]` | remove the dangling link in Step 10; tick it to attempt repair instead |
| `not installed · ★ recommended` | `—` | `[ ]` | nothing — unless the user ticks it or replies `recommended` |

**The three-way diff for `conflicting upgrade`.** For each row in that state, compare:

- *source @ recorded* — read from `<source-root>/.versions/<recorded-version>/<artifact-path>`
- *installed copy* — read from the target path in the workspace
- *source @ current* — read from `<source-root>/<artifact-path>`

If the recorded snapshot is missing (unpublished local build, or a version older than the snapshot retention), fall back to "treat installed copy as canonical" — do not pretend a diff exists. Mention the missing snapshot in the row's status text so the user can decide.

After the table, ask: *"Which items in this group? — adjust the picks, or reply `all` / `recommended` / `none` / `keep` (keep the pre-selection as shown)."* `recommended` ticks every `★` item **in addition to** the already-installed pre-selection (so the user never accidentally removes installed items by accepting recommendations). `keep` is the no-change shortcut.

For an already-configured workspace, an **unchecked installed item means *remove it*** (subject to the removal-scope rule); a **checked one means *keep or update it***. An `St` token appears for every row — even `—` (not installed) — with the legend shown once above the table, so the user always sees an explicit state instead of inferring it from an empty checkbox.

**Source availability filter — never substitute across agents.** Each row is offered only when the source file the **chosen agent** needs already exists in this repo. The source location is fixed per agent:

| Artifact | claude-code source | opencode source | pi source |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| Personas | `agents/<name>.md` | `agents/<name>.md` | `agents/<name>.md` |
| Commands / prompts | `.claude/commands/<name>.md` | `.opencode/commands/as-<name>.md` | `.pi/prompts/<name>.md` |
| pi extensions / harnesses / runtime skills | — | — | `.pi/extensions/<name>/`, `.pi/harnesses/<name>/`, `.pi/skills/<name>/` |
| References / hooks | source files in `references/` / `hooks/` |

If the per-agent source is missing, the row is **not shown** — never silently fall back to a different agent's tree (for example: do not symlink `.claude/commands/design-agent.md` from `.pi/prompts/design-agent.md` when the agent is `pi`). When the user explicitly asks for an item the source lacks for their agent, say so plainly and stop; the answer is to author the missing source file first, not to cross-link runtimes.

Groups, in order. Groups 1–4 apply to every agent; groups 5–7 are shown **only when the agent is `pi`**.

1. **Skills** *(`Group` column = lifecycle phase)* — one screen for all skills, ordered by phase:
   - *Define / Plan* — `spec-driven-development` ★, `planning-and-task-breakdown` ★, `idea-refine`
   - *Build* — `incremental-implementation` ★, `test-driven-development` ★, `context-engineering`, `source-driven-development`, `frontend-ui-engineering`, `api-and-interface-design`
   - *Verify* — `browser-testing-with-devtools`, `debugging-and-error-recovery` ★
   - *Review* — `code-review-and-quality` ★, `code-simplification`, `security-and-hardening`, `performance-optimization`
   - *Ship* — `git-workflow-and-versioning` ★, `ci-cd-and-automation`, `deprecation-and-migration`, `documentation-and-adrs`, `shipping-and-launch`
   - *Meta* — `using-agent-skills` ★, `designing-agents` *(`guided-workspace-setup` is installer-only — never offered)*
2. **Agent personas** *(`Group` column = `writeable` / `read-only`)* — one screen. Read-only personas carry `tools: read,bash,grep,find,ls` and an explicit "Do NOT modify files." rule:
   - *writeable* — `builder`, `documenter`
   - *read-only* — `code-reviewer` ★, `test-engineer` ★, `security-auditor`, `planner`, `plan-reviewer`, `scout`
3. **Commands / prompts** *(single-type — no `Group` column)* — mapped to the chosen agent; items without a per-agent source are filtered out, no cross-tool substitution. Full candidate list: `spec` ★, `plan` ★, `build` ★, `test` ★, `review` ★, `code-simplify`, `ship`, `design-agent`, `prime`. The actual menu shows only items whose per-agent source file exists — for example, `.pi/prompts/design-agent.md` and `.pi/prompts/prime.md` are absent, so neither is offered when the agent is `pi`. *(`setup` and `doctor` are installer-only — never offered, since they live in the source agent-skills repo and act on target workspaces from there.)*
4. **References & Hooks** *(`Group` column = `reference` / `hook`)* — one screen for the shared non-agent-specific artifacts:
   - *reference* — testing, performance, security, accessibility checklists
   - *hook* — `session-start.sh`, `simplify-ignore.sh` (+ `simplify-ignore-test.sh`)
5. **pi extensions & runtime skills** *(pi only; `Group` column = `extension` / `runtime-skill`)* — always-on once installed:
   - *extension* — `mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`, `agent-skills-update-check` ★, `btw`
   - *runtime-skill* — `bowser`
6. **pi harnesses** *(pi only; `Group` column = harness category — install many, load through the explicit recipes; `just hub` stacks `damage-control` before `agent-hub`)* — one screen for all harnesses:
   - *orchestration* — `agent-hub`, `pi-pi`
   - *safety* — `damage-control`
   - *messaging* — `coms`, `coms-net`

   **Harness companions (refreshed with the group, not separate rows).** A harness directory does not run on its own — the launch recipes live in the `justfile`, and several harnesses shell out to support files. So whenever **any** harness in this group is ticked (installed/kept) or unticked (removed), refresh its companions from source in the same pass — they are not shown as their own menu rows:
   - `justfile` — the `just hub` / `just team-up` / `just coms` launch recipes plus private helpers.
   - `scripts/team-up.ts`, `scripts/coms-net-server.ts` — used by the `team-up` and `coms-net-server` recipes.
   - `.pi/agents/peers.yaml`, `.pi/agents/teams.yaml`, and the peer personas they name (e.g. `architect`, `releaser`) — read by `team-up`.
   - `.pi/damage-control-rules.yaml` — the rule set the damage-control harness loads.
   - `.pi/harnesses/package.json` (+ `npm install --prefix .pi/harnesses`) — the harness runtime deps (`yaml`, `@sinclair/typebox`).

   **The `justfile` is the one that goes stale on upgrade.** Refresh it from the **current** source, never leave the installed copy as-is: the source `justfile` is canonical, so refreshing it prunes recipes for harnesses retired since the recorded version and adds recipes for new ones. A workspace whose harness set changed between versions but whose `justfile` was left untouched is the exact failure this rule prevents — `just --list` keeps recipes pointing at deleted `.pi/harnesses/<name>/` dirs and lacks recipes for the new harnesses. Treat the `justfile` as a normal versioned artifact subject to the Step 6 status rules: it carries its own `St` token in the menu's after-table restate line (`ok`/`upd`/`mod`/`cflt`), and a user-edited `justfile` gets the same three-way diff and pre-unchecked `cflt` treatment as any other modified file — never a silent clobber. The `.versions/<recorded>/justfile` snapshot is the recorded-side of that diff.

   **The `justfile` managed region.** The source `justfile` wraps its recipes between `# >>> agent-skills:harnesses … >>>` and `# <<< agent-skills:harnesses <<<` sentinels. Only that region is agent-skills'. When refreshing into a target that has its own recipes outside the sentinels, replace **only** the managed region (preserving the user's recipes); if the target has no sentinels but every recipe matches the recorded-version `justfile` snapshot (i.e. the user never edited it), it is wholly ours — refresh the whole file, re-introducing the sentinels. If the target has no sentinels **and** has diverged from the snapshot, treat it as `mod`/`cflt` and show the diff before touching it. When merging into a `justfile` that already declares its own `set dotenv-load`, drop that line from the region rather than duplicating the setting (just errors on a repeated setting).

7. **External pi packages** *(pi only — companion packages recorded in pi settings, not copied from this repo)* — `pi-ask-user` ★. On a `pi` re-run this is normally already `installed · project package` because Step 5b bootstrapped it; the row exists so the user can keep, remove, or re-scope it.

Defaults differ by workspace state:

- **Fresh workspace (no install record).** Pre-selection is empty; replying `recommended` ticks the `★` items across groups 1–4. pi groups (5–7) stay empty unless the agent is `pi`.
- **Existing workspace.** Pre-selection mirrors the install record — every `installed · *` row starts `[x]`. Replying `keep` accepts that pre-selection unchanged; replying `recommended` adds the `★` items on top of what is already installed (it never silently unticks installed items).

Because groups now span sub-categories, the shortcuts (`all`, `recommended`, `none`, `keep`) and any comma-separated picks apply to the **whole group screen**, across every sub-category in it. After every group, restate the picks in one line so the user can correct them before moving on. The restate line uses the same status vocabulary — for example: *"Skills: keep `code-review-and-quality` (up to date), install `security-and-hardening` (recommended), remove `performance-optimization`."*

**External pi package status.** For Group 7, treat `pi-ask-user` as an external pi package rather than an agent-skills artifact. In the normal `pi` flow Step 5b has already installed it, so it usually arrives here as `installed · project package`. The four states below are the decision logic for that row; in the rendered table the `St` cell is `pkg` for any installed scope (state the scope in the after-table restate line) and `—` when not installed:

- `installed · bundled by @chankov/agent-skills` — the workspace uses `pi install npm:@chankov/agent-skills`; leave `pi-ask-user` unchecked/no-op and do not add a duplicate package entry.
- `installed · project package` — `.pi/settings.json`/`pi list` already records `npm:pi-ask-user` (most often because Step 5b installed it); pre-check it to keep.
- `installed · global package` — user settings already provide `npm:pi-ask-user`; leave project install unchecked unless the user wants a project-scoped pin.
- `not installed` — only reached when the user declined the Step 5b bootstrap and ran the menu in tabular fallback. Recommend `pi install -l npm:pi-ask-user` for project-scoped setup. Mention `pi install npm:pi-ask-user` only when the user chose a global pi setup.

When selected during a clone/symlink or manual pi setup — or installed by the Step 5b bootstrap — record `pi-ask-user` under an `external-pi-packages` / `project-packages` line in `.ai/agent-skills-setup.md`; do not copy files from `node_modules` or this repo. When deselected later, remove only the package entry this setup owns (for example the project-scoped `.pi/settings.json` entry it recorded). Never remove a user-owned global package or a package entry that predates the install record.

**Removal scope — what "unchecked = remove" actually touches.** A target item is eligible for removal only when **both** are true:

1. **It is part of the agent-skills inventory.** Its name matches an artifact shipped in the source repo's canonical trees (`skills/`, `agents/`, `.claude/commands/`, `.pi/prompts/`, `.pi/extensions/`, `.pi/harnesses/`, `.pi/skills/`, `references/`, `hooks/`). Out-of-inventory items — user-authored skills, project-specific commands, custom personas, third-party plugins, external pi packages, unrelated dotfiles — are never proposed for removal even if they sit in the same directory.
2. **It is recorded in this workspace's install record.** The `## install-status` section of `.ai/agent-skills-setup.md` lists it as previously installed by this skill, *or* it is a symlink whose target resolves into the agent-skills source root (which is unambiguously ours).

If a candidate fails either test, list it once under a "Skipped — not owned by agent-skills" line in the Step 9 plan and leave it alone. Settings files (`.claude/settings.json`, `.opencode/config*`, env vars, MCP config) are touched **only** to remove agent-skills' own hook registrations — never other keys, never user env vars, never third-party MCP entries.

### 7. Offer project overrides

From the Step 4 analysis, propose draft override sections for `.ai/agent-skills-overrides.md` — `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`.

For `pi` workspaces where `agent-hub` is selected, installed, or kept, also offer its user-facing language override:

- Section: legacy `## agent-team`
- Key: `language: English` as the offered default
- Existing section: preserve the current `language` value in the draft and let the user edit it
- Omitted section: keep `agent-hub`'s default English

Write each section as terse `key: value` lines, never prose: the lifecycle skills and `agent-hub` load this file on every run/session start and parse it by key, so it stays minimal. Show the draft and let the user edit, accept, or skip each section. Reference env-var names for any credentials; keep secrets out of the file.

### 8. Choose the install method

Ask `copy` or `symlink` for this run.

- `copy` — copy each artifact into its target path.
- `symlink` — link each target path to the source artifact in the agent-skills repo.

### 9. Confirm the plan

Present the plan compactly — the **"Keep it narrow"** rule from Step 6 applies here too, since this confirmation renders in the same `pi-ask-user` widget. Do **not** render a wide multi-column table: a `Target paths` column plus a `Notes` column plus an `Artifacts` cell that lists every skill name is exactly what overflows the terminal and forces the user to zoom out. Instead, group the plan by action — one short line per action, each artifact list wrapping naturally:

- `Add (N): a, b, c` — newly ticked items
- `Refresh (N): a, b` — re-installed from source; append `— overwrites local edits` when any row was `mod`
- `Remove (N): a` — unticked installed items (removal-scope rule already applied)
- `Keep (N)` — render as a count, not a full name list (expand only if the user asks)
- `Records: stamp v<current>, update install-status + overrides`
- `Method: copy` (or `symlink`)

Target paths are deterministic from the per-agent source map, so omit them from the confirmation — show a path only when the user asks. When the version delta from Step 4 is non-empty, lead with a short **"Changes since `v<recorded>` → `v<current>`"** heading followed by one short bullet per change (sourced from `CHANGELOG.md`, only the entries between the two versions) — bullets on their own lines, never crammed into one long line that overflows. Ask the user to confirm, and write nothing until they do.

**Installer cleanup line.** The summary always ends with one line stating that the installer slash commands (`/setup-agent-skills`, `/doctor-agent-skills` — or `/as-*-agent-skills` for OpenCode — plus the `guided-workspace-setup` skill body) will be removed after apply, so they do not pollute the user's slash-command list. Add the verbatim suffix: *"Reply `keep` to leave them in place; re-run `npx @chankov/agent-skills init` later if removed."* If the user replies `keep`, record `keep-installer: true` in `## workspace-summary` and skip Step 10b. Otherwise the default is to remove them.

### 10. Apply the setup

Apply the changes: create directories, add or update selected artifacts, and remove deselected ones — **bound by the removal-scope rule from Step 6**. Before deleting any target, verify both conditions: (a) the name is in the agent-skills inventory and (b) the item is either listed in `## install-status` or is a symlink resolving into the source repo. If either check fails, skip the deletion silently and log the path under a "Skipped — not owned by agent-skills" line in the final report.

**Apply without mid-flight questions.** Refresh every ticked item from its per-agent source unconditionally. Do not pause to ask whether to overwrite a modified file — `installed · modified` already appeared in Step 6 with the explicit warning that refreshing overwrites local edits, and the user's tick is the consent. The Step 9 confirmation is the single gate; nothing further is asked during apply. (If the apply hits a genuine error — permission denied, source missing, broken target type — stop, report it, and ask how to proceed; that is not the same as soliciting consent.)

For settings files (`.claude/settings.json` and equivalents), edit only the agent-skills hook entries; leave every other key — user permissions, env vars, third-party MCP servers, custom hooks — untouched.

**pi harness companions.** When this pass installs, refreshes, or removes any pi harness (Step 6 group 6), apply the companion set in the same pass per the Step 6 rules:

- Refresh `scripts/team-up.ts`, `scripts/coms-net-server.ts`, `.pi/agents/peers.yaml`, `.pi/agents/teams.yaml`, the peer personas they name, `.pi/damage-control-rules.yaml`, and `.pi/harnesses/package.json` from source (then `npm install --prefix .pi/harnesses` for the runtime deps).
- Refresh the `justfile` from the **current** source into its managed region (between the `# >>> agent-skills:harnesses … >>>` / `# <<< agent-skills:harnesses <<<` sentinels), preserving any user recipes outside it — this is what prunes retired-harness recipes and adds new ones. In symlink mode, link the whole `justfile` to source **only** when the target has no `justfile` or its existing one is wholly agent-skills'; if the target carries user recipes, fall back to a copy-mode managed-region rewrite so those recipes survive.
- **Removal:** when the **last** pi harness is removed, strip the agent-skills managed region from the `justfile` (and drop the now-orphaned `scripts/`/`.pi/agents/` companions that no remaining harness needs), bound by the same removal-scope rule — never delete user recipes outside the sentinels, and never delete a companion the user authored.

Then write both `.ai/` files: the agreed override sections from Step 7 into `.ai/agent-skills-overrides.md`, and the install record — artifacts, target paths, method, **package version**, date — into `.ai/agent-skills-setup.md`. The `version:` line in `## workspace-summary` is set to the package version from Step 2; this is what the next re-run will compare against to compute the version delta.

### 10b. Remove the installer artifacts (unless the user said `keep`)

After Step 10 has written the catalogue + the `.ai/` files, the installer files dropped by `npx @chankov/agent-skills init` — the `setup-agent-skills` / `doctor-agent-skills` slash commands and the `guided-workspace-setup` skill body itself — are no longer needed in the workspace. They were bootstrap plumbing, not part of the user's permanent install. Leaving them in place pollutes the agent's slash-command list and confuses re-runs (which should always go through `init`, not a stale local copy).

Default behaviour:

- **`keep-installer: true` in `## workspace-summary`** → skip this step. The files stay.
- **Otherwise** → run the cleanup. Delete every file the bootstrap wrote for the chosen agent:

| Agent | Files removed |
|---|---|
| `claude-code` | `.claude/commands/setup-agent-skills.md`, `.claude/commands/doctor-agent-skills.md`, `.claude/skills/guided-workspace-setup/SKILL.md` |
| `pi` | `.pi/prompts/setup-agent-skills.md`, `.pi/prompts/doctor-agent-skills.md`, `.pi/skills/guided-workspace-setup/SKILL.md` |
| `opencode` | `.opencode/commands/as-setup-agent-skills.md`, `.opencode/commands/as-doctor-agent-skills.md`, `.opencode/skills/guided-workspace-setup/SKILL.md` |

After deleting, prune any directories that were created solely for these files (e.g. `.claude/skills/guided-workspace-setup/`) — never prune a directory that contains other files.

Note: the skill body file you are removing here is the same file the agent is *currently executing*. Filesystem removal does not interrupt the in-memory copy — finish this step, then Step 11, then return as normal.

If `cleanupInstaller` is available via the CLI (`npx @chankov/agent-skills cleanup-installer --agent <agent> --workspace <path>`), invoking it is equivalent to the manual deletions above; either path is acceptable. Failures (permission denied, file already gone) are logged but do not abort the apply.

### 11. Verify and report

Re-scan the install-target directories one more time and confirm: every selected artifact exists at its target path, every deselected one is gone, and zero broken symlinks remain. When pi harnesses were touched, also confirm the `justfile` is consistent with the installed harness set: every installed harness has its launch recipe, and **no recipe points at a `.pi/harnesses/<name>/` that is not installed** (a leftover recipe for a retired harness is the regression this check catches). Also re-read `.ai/agent-skills-setup.md` and verify the `version:` line matches the package version from Step 2 — a mismatch here means the apply pass did not stamp the new version, and must be corrected before the next re-run computes the wrong delta. If the post-apply scan surfaces any new breakage, treat it as a doctor finding and offer the same repair options as Step 5, then append a second `## doctor-runs` line with `phase: postflight`. List what changed, point the user at `.ai/agent-skills-overrides.md` and `.ai/agent-skills-setup.md`, and suggest loading `using-agent-skills` first in their next session.

Close the report with one line explaining the installer-cleanup outcome:

- If Step 10b ran: *"Installer slash commands removed from your workspace. Re-run `npx @chankov/agent-skills init` if you need `/setup-agent-skills` back."*
- If Step 10b was skipped (`keep-installer: true`): *"Installer slash commands kept in place per your choice. `/setup-agent-skills` and `/doctor-agent-skills` remain available."*

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The user wants everything — I'll install all skills without asking." | Loading every skill wastes context and dilutes discovery. The per-group menu and the `★` recommendations exist so a workspace gets only what it needs. |
| "I'll skip the doctor preflight — the menu will surface broken items anyway." | Broken symlinks distort the install menu's `installed` / `not installed` state. Repair first so the menu reflects reality. |
| "I'll collapse the 7 groups into one big checklist — it's faster." | The 7 groups are how the user reasons about scope (skills vs personas vs commands vs pi-only). A single flat list of ~50 items makes recommendations and sub-category labels meaningless. Keep the 7 screens; within a multi-type group, the `Group` column preserves the sub-sections. |
| "I'll re-split the Skills group back into one screen per phase — six small screens are clearer." | The whole point of the restructure is 7 screens, not 19. The `Group` column already labels the phase within the single Skills screen; splitting it back re-introduces the screen sprawl we removed. |
| "The agent is `pi` and `pi-ask-user` is missing — I'll just run the menu in the tabular fallback and skip the bootstrap." | Step 5b exists precisely to avoid forcing a ~50-row menu through plain text. Offer the install-then-reload bootstrap first; only fall back to tabular if the user *declines*. |
| "I installed `pi-ask-user` in Step 5b, so I'll keep going straight into the install menu in the same pass." | The tool only becomes callable after pi reloads. Stop the pass after install, ask the user to reload and re-run; the native widget is unavailable until then. |
| "I'll copy the files now and confirm afterwards." | Writing before the Step 9 confirmation can clobber config the user wanted to keep. Confirmation is the only gate that protects the target workspace. |
| "There is no `*-setup.md` for this agent, so I'll guess the install paths." | Guessed paths put artifacts where the agent never loads them. Read the agent's setup doc, or use the built-in map — a location is never invented. |
| "The workspace already has a `.claude/` directory, so setup is done." | A directory existing is not install state. The `## install-status` section is the only record of what this skill installed; read it before deciding. |
| "An existing file differs from the source — I'll pause and ask the user mid-apply whether to overwrite." | Step 6 already surfaced `installed · modified` with the warning that refreshing overwrites local edits. The user's tick is the consent. Mid-apply questions break the apply pass; they were replaced by the upfront status. |
| "`.pi/prompts/design-agent.md` doesn't exist, but `.claude/commands/design-agent.md` does — I'll symlink to the Claude file so the user gets the prompt." | That mixes runtimes silently and lets the source repo's claude-code tree drive a pi target. The source availability filter forbids it: items without a per-agent source are not offered at all. |
| "The harness directories installed fine — the `justfile` is just launch shortcuts, I'll leave the existing one." | The `justfile` is how harnesses are launched; if it is not refreshed from the current source, retired-harness recipes linger (pointing at deleted `.pi/harnesses/<name>/` dirs) and newly added harnesses have no recipe at all. It is a companion of the harness group and must be refreshed whenever any harness changes. |
| "I'll just copy the source `justfile` over the target's to refresh it." | A wholesale copy clobbers any recipes the user authored. Refresh only the managed region between the `agent-skills:harnesses` sentinels; a user-edited `justfile` outside that region is `mod`/`cflt` and gets the three-way diff first — never a silent overwrite. |
| "I'll skip the workspace analysis and just ask the user everything." | The analysis is what makes the override offer accurate. Asking blind produces an overrides file the user has to hand-correct afterwards. |
| "I'll record the full install detail in the overrides file too — one place is simpler." | Other skills load the overrides file on every run. Install detail belongs only in `agent-skills-setup.md`; padding the overrides file taxes every later session. |
| "There's an unfamiliar skill in `.claude/skills/` — the user must have forgotten to uncheck it, I'll remove it." | The removal scope rule exists exactly to prevent this. If the name is not in the agent-skills inventory or not in `## install-status`, it is user-owned; leave it alone and log it as skipped. |
| "The user wants a clean workspace — I'll prune custom hooks and unrelated MCP entries from `settings.json` too." | Setting-file edits are limited to agent-skills' own hook registrations. Touching anything else silently deletes work that does not belong to this skill. |
| "`/setup-agent-skills` and `/doctor-agent-skills` are useful — I'll re-install them at the end of apply so the user can re-run them locally." | They are installer commands that the CLI bootstraps and the skill itself cleans up in Step 10b by default. Keeping them is opt-in via `keep` in Step 9. Re-installing them silently undoes the cleanup the user implicitly chose. |
| "The bootstrap marker is missing — I'll search the user's `~/repos/`, `~/projects/`, and `/media/` for any clone of `agent-skills` to use as the source root." | Scanning the user's filesystem picks up dev clones, forks, half-edited working trees, and stale checkouts that are NOT the package the user installed from. The npm-installed copy is the only authoritative source after `init`. Without the marker, ask the user explicitly — never guess. |
| "This `SKILL.md` is two levels below the workspace's `.pi/skills/`, so the workspace root must be the source root." | Bootstrap copies `SKILL.md` into the workspace precisely so the slash command can load it. The workspace is the *target* of the install, not the source. Use the marker file to find the real source; resolving from `SKILL.md`'s workspace location always lies. |
| "The recorded version differs from the current — I'll just refresh everything to the new source without showing the diff." | Conflicting upgrades (user-modified copy + source changed upstream) require the three-way diff to be shown in Step 6, with the row pre-unchecked. Refreshing silently overwrites work the user did between versions. |
| "The `.versions/<recorded>/` snapshot is missing — I'll pretend the installed copy matches the recorded source and refresh anyway." | A missing snapshot means we cannot compute the three-way diff. The skill must fall back to "treat installed copy as canonical" and surface the missing snapshot in the row's status so the user can decide — never pretend a diff exists. |
| "The workspace has no `version:` line — I'll silently stamp the current version and move on." | A pre-versioning workspace must be flagged in Step 4 and the user prompted: stamp the current version (assume copies match) or wipe and reinstall. Silent stamping hides a real decision. |
| "The user didn't say anything about the installer cleanup line — I'll leave the installer files in place to be safe." | The default is to remove. Step 9's confirmation line explicitly states the cleanup will happen unless the user replies `keep`. Silence is consent for the default, not opt-out from it. |
| "I'll add `setup-agent-skills` and `doctor-agent-skills` to the install menu so the user can pick whether to keep them." | They are still installer-only and excluded from the menu. The keep-vs-remove choice is the single Step 9 line, not a menu group — adding them to the menu re-opens the pollution we just fixed. |
| "The skill is currently executing; deleting its own file in Step 10b will crash mid-run." | The agent loads the skill into memory at the start of execution. Removing the file on disk does not unload the in-memory copy — Steps 10b and 11 complete normally before control returns. |

## Red Flags

- Files written to the target workspace before the Step 9 confirmation.
- The doctor preflight skipped on a workspace that already has prior install state.
- An install menu rendered as one undifferentiated list instead of the 7 grouped tables (≤ 8), or the Skills group re-split into one screen per phase.
- A multi-type group (Skills, Agent personas, References & Hooks, pi extensions & runtime skills, pi harnesses) rendered without the `Group` sub-category column.
- The agent is `pi`, `pi-ask-user` is missing, and the install menu was rendered in tabular fallback without first offering the Step 5b bootstrap.
- Step 5b installed `pi-ask-user` but the pass continued into the install menu instead of stopping for the user to reload and re-run.
- A menu group rendered without a per-row `St` token (or without the legend that defines them), or with installed items not pre-checked.
- A menu table rendered with the long `installed · …` state names, a separate `Rec` column, or wide cells/preamble that overflow the terminal — render the compact form so the `pi-ask-user` widget fits without zooming.
- The Step 9 confirmation rendered as a wide multi-column table (a `Target paths` or `Notes` column, or an `Artifacts` cell listing every skill name) instead of compact action-grouped lines, or the "Changes since" delta crammed into one long line instead of short per-change bullets.
- A `recommended` reply that silently unticks already-installed items instead of adding `★` items on top.
- `setup`, `doctor`, or `guided-workspace-setup` shown in the install menu — they are installer-only.
- An item offered for one agent whose per-agent source file does not exist (cross-tool substitution).
- A mid-apply prompt asking whether to overwrite a modified target file — that consent belongs in Step 6 / Step 9, not in Step 10.
- A target file or directory deleted whose name is not in the agent-skills inventory, or that is not recorded in `## install-status` and is not a symlink into the source repo.
- Edits to `settings.json` / env vars / MCP config beyond removing agent-skills' own hook registrations.
- An artifact installed to a path backed by neither the built-in map nor the agent's `*-setup.md`.
- pi harnesses installed, refreshed, or retired without the `justfile` being refreshed — its `just --list` still shows recipes for removed harnesses, points at `.pi/harnesses/<name>/` dirs that are not installed, or lacks recipes for newly added harnesses.
- The `justfile` (or `scripts/`/`.pi/agents/` companions) overwritten wholesale, clobbering recipes or files the user authored outside the agent-skills managed region.
- `.ai/agent-skills-setup.md` left unchanged after artifacts were added or removed.
- Credentials or secrets written into either `.ai/` file.
- Every skill installed when the workspace needs a handful.
- An existing, differing target file overwritten without asking the user.
- A re-run that ignores the existing `## install-status` and reinstalls everything.
- A `pi` workspace using `agent-hub` reached Step 7 without being offered the legacy `## agent-team` / `language: <value>` override, or an existing language value was overwritten instead of preserved.
- The overrides file padded with install status, summaries, or prose instead of terse `key: value` sections.
- A re-run that detects a non-empty version delta but skips the "Changes since v<recorded> → v<current>" block in Step 9.
- A `conflicting upgrade` row pre-checked, or the three-way diff omitted for it.
- A pre-versioning workspace stamped with the current version without prompting the user first.
- The post-apply `version:` line not matching the package version from Step 2.
- Step 9 summary missing the installer-cleanup line, or the line stated `keep` as the default.
- Source root resolved by scanning the filesystem for `agent-skills` repos (`find`, `fd`, `grep -r`, …) instead of using `.ai/.agent-skills-bootstrap.json` or asking the user.
- Source root resolved by treating `SKILL.md`'s workspace location (`.pi/skills/...` or `.claude/skills/...`) as the package root.
- The bootstrap marker file (`.ai/.agent-skills-bootstrap.json`) ignored when present, or trusted blindly when the path it names no longer exists.
- Installer files (`setup-agent-skills`, `doctor-agent-skills`, the `guided-workspace-setup` skill body) left in place without a recorded `keep-installer: true`.
- `setup-agent-skills` or `doctor-agent-skills` shown as install-menu rows.
- Step 11 report omitting the one-line installer-cleanup outcome.

## Verification

After completing the workflow, confirm:

- [ ] The workspace path was validated as an existing directory before any write.
- [ ] The coding agent was confirmed, and `docs/<agent>-setup.md` was read for `opencode`/`pi` (or the built-in map used for `claude-code`).
- [ ] The doctor preflight ran on any workspace with prior install state, and its findings were resolved or explicitly skipped.
- [ ] On `pi`, Step 5b ran before the menu: `pi-ask-user` was either already present (no-op) or its install-then-reload bootstrap was offered; the pass stopped after install when it was bootstrapped, and was not forced when the user declined.
- [ ] The install menu was presented as the 7 grouped tables (groups 5–7 shown only for `pi`), not 19 screens and not one flat list; each was its own multi-select with `★` recommendations marked.
- [ ] Each multi-type group (Skills, Agent personas, References & Hooks, and the pi extension/harness groups) carried a `Group` sub-category column ordering its rows.
- [ ] Every row carried an explicit `St` token (`ok`, `upd`, `mod`, `cflt`, `gone`, `new`, `pkg`, `—`, or `brk`) with the legend shown once above the table — never blank and never the long `installed · …` state names that overflow the widget.
- [ ] Installed items were pre-checked `[x]`; not-installed items were pre-checked `[ ]`; `recommended` added `★` items on top of the pre-selection without unticking installed ones.
- [ ] Items lacking a per-agent source were filtered out of the menu — no cross-tool substitution offered.
- [ ] Apply ran without any overwrite-this-file prompt; ticked items refreshed unconditionally and unticked modified items were preserved.
- [ ] `setup`, `doctor`, and `guided-workspace-setup` were excluded from the install menu.
- [ ] Every selected artifact exists at its resolved target path; every deselected one was removed **only if** the removal-scope rule allowed it (in inventory + in install record / symlink-into-source).
- [ ] When pi harnesses were installed/refreshed/removed, the `justfile` and harness support files were refreshed from the current source: the `justfile` lists a recipe for every installed harness, none for a removed one, and points at no missing `.pi/harnesses/<name>/`; user recipes outside the managed-region sentinels were preserved.
- [ ] Out-of-inventory and unrecorded items found in the install-target directories were left untouched and logged under "Skipped — not owned by agent-skills".
- [ ] Settings-file edits were limited to agent-skills' own hook entries; no user keys, env vars, or third-party MCP entries were modified.
- [ ] `.ai/agent-skills-overrides.md` holds the agreed override sections as terse `key: value` lines, and nothing else.
- [ ] For `pi` workspaces using `agent-hub`, the legacy `## agent-team` language override was offered, existing values were preserved, and omitting the section was treated as default English.
- [ ] `.ai/agent-skills-setup.md` holds an up-to-date install record, including at least one `## doctor-runs` entry for this session, and a `version:` line in `## workspace-summary` that matches the package version from Step 2.
- [ ] Step 9 was rendered as compact action-grouped lines (Add / Refresh / Remove / Keep-count / Records / Method), not a wide `Target paths` + `Notes` table that overflows the widget.
- [ ] When the version delta was non-empty, Step 9's summary led with the "Changes since v<recorded> → v<current>" heading followed by short per-change bullets sourced from `CHANGELOG.md` — never one long overflowing line.
- [ ] Every `conflicting upgrade` row was rendered with its three-way diff in Step 6 and was not pre-checked.
- [ ] A pre-versioning workspace was flagged in Step 4 and the user was prompted to stamp or wipe — not silently stamped.
- [ ] Source root was resolved from `.ai/.agent-skills-bootstrap.json` if present, or from `SKILL.md`'s realpath (symlink mode), or by asking the user — **never** by scanning the filesystem.
- [ ] If the bootstrap marker named a path that no longer exists, the user was warned and asked for a new path — not silently ignored.
- [ ] Step 9 summary ended with the installer-cleanup line: states remove-by-default and offers `keep` as the opt-out.
- [ ] Step 10b ran (or was explicitly skipped because `keep-installer: true`); the installer files are absent from the workspace unless the user opted to keep them.
- [ ] Step 11 report includes the one-line installer-cleanup outcome.
- [ ] No broken symlinks remain in any of the scanned install-target directories.
- [ ] No YAML config references a removed persona name.
- [ ] No secrets were written to either `.ai/` file.
- [ ] The user confirmed the plan in Step 9 before any file was written.
