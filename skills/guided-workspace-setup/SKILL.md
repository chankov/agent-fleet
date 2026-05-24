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

This skill is run from the agent-skills repo with the target coding agent active, and invoked with a path to the workspace to configure. Steps are gated — nothing is written to the target workspace until the user confirms in Step 9.

It maintains two files in the target's `.ai/` directory: `agent-skills-overrides.md` holds the minimal per-skill overrides that other skills read on every run, and `agent-skills-setup.md` holds the install record this skill itself reads on re-runs. The overrides file stays small; the install record absorbs the bulk.

### 1. Detect interaction capability

Determine which interaction mode this runtime supports, in order of preference:

- **Native multi-select widget** (e.g. a runtime that renders true checkbox lists) — use it for every group in Step 6.
- **`AskUserQuestion` with `multiSelect: true`** — usable when a group has ≤ 4 options, since the tool caps options at 4. Larger groups fall back to the next mode.
- **Tabular fallback** — print the group table (Step 6 format) and ask the user to reply with the picks. Always accept the shortcuts `all`, `recommended`, `none`, or a comma-separated list of item names/numbers.

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
| Personas | `.claude/agents/<name>.md` | per `docs/opencode-setup.md` | `.pi/agents/<name>.md` |
| Commands / prompts | `.claude/commands/<name>.md` | `.opencode/commands/as-<name>.md` | `.pi/prompts/<name>.md` |
| References | `.claude/references/<name>.md` | per `docs/opencode-setup.md` | per `docs/pi-setup.md` |
| Hooks | `.claude/hooks/<name>`, registered in `.claude/settings.json` | per `docs/opencode-setup.md` | per `docs/pi-setup.md` |
| pi extensions | — | — | `.pi/extensions/<name>/` |
| pi harnesses | — | — | `.pi/harnesses/<name>/` |

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

- `agents/`, `.claude/agents/`, `.opencode/agents/`, `.codex/agents/`, `.gemini/agents/`, `.github/agents/`, `.pi/agents/` (and its `pi-pi/` subdirectory)
- `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`
- `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`
- `.claude/references/`, `.claude/hooks/`

For each broken link discovered:

1. Resolve where the link **was** pointing (`readlink`) and look up the canonical replacement in the source `agents/` or `skills/` tree — many breakages are stale names from the pre-merge layout (e.g. `reviewer` → `code-reviewer`, `red-team` → `security-auditor`).
2. If a canonical replacement exists, offer to repoint the symlink to it.
3. If no replacement exists, offer to delete the broken link.
4. Never overwrite a regular file you find at a target path — only act on symlinks whose target is missing.

Also flag any YAML configs (`teams.yaml`, `agent-chain.yaml`) that still reference removed persona names, and offer to rename the references to the canonical name.

Present findings in a single table:

| # | Path | Issue | Suggested fix |
|---|---|---|---|
| 1 | `.claude/agents/reviewer.md` | broken symlink → missing `agents/reviewer.md` | repoint to `agents/code-reviewer.md` |
| 2 | `.pi/agents/red-team.md` | broken symlink, no replacement | delete |
| 3 | `.pi/agents/teams.yaml` | references `red-team` | rename to `security-auditor` |

Then ask, multi-select: which fixes to apply now. Apply only the picked ones; record skipped items so the install menu can surface them again. Append a `## doctor-runs` line to `.ai/agent-skills-setup.md` with the date, agent, phase (`preflight`), and `repaired` / `deleted` / `skipped` counts.

The doctor scan is also exposed standalone as `/doctor-agent-skills` — running it outside a setup pass is this same scan-and-repair flow without the rest of the install menu.

### 6. Present the install menu

Offer every installable artifact, split into the groups below. **Each group is its own multi-select prompt** so the user can pick at the finest granularity. Within a group, render the items as a markdown table using this fixed format:

| Pick | Item | Status | Rec | Purpose |
|---|---|---|---|---|
| `[x]` / `[ ]` | `<name>` | one of the Status values below | `★` if recommended, else blank | one-line purpose |

**Pre-selection rule.** The `Pick` column is pre-ticked from the workspace's current state — not from preference. Every item is either pre-checked `[x]` (touched if confirmed) or pre-unchecked `[ ]` (left alone if confirmed):

| Current state | Pre-check | What confirming will do |
|---|---|---|
| `installed · up to date` | `[x]` | no-op (kept as-is) |
| `installed · outdated` (source newer than the installed copy; copy-mode only) | `[x]` | refresh to current source |
| `installed · modified` (target diverged from source) | `[x]` | refresh from source — **local edits will be overwritten**; untick to preserve them |
| `installed · upgrade available` (recorded version != current; user copy still matches the recorded-version source) | `[x]` | clean refresh to the current-version source |
| `installed · conflicting upgrade` (recorded version != current; user modified the copy AND source changed upstream) | `[ ]` | nothing — show the three-way diff (recorded vs installed vs current) inline and ask before any write; tick only after the user accepts the overwrite |
| `installed · removed upstream` (artifact gone in the current version) | `[x]` | propose deletion in Step 10 (subject to the removal-scope rule); untick to keep the local copy |
| `not installed` | `[ ]` | nothing — unless the user ticks it to install |
| `not installed · new in this version` (artifact added between recorded and current) | `[ ]` | nothing — unless the user ticks it; marked `★` if recommended |
| `broken · skipped in preflight` (carried over from Step 5) | `[ ]` | remove the dangling link in Step 10; tick it to attempt repair instead |
| `not installed · ★ recommended` | `[ ]` | nothing — unless the user ticks it or replies `recommended` |

**The three-way diff for `conflicting upgrade`.** For each row in that state, compare:

- *source @ recorded* — read from `<source-root>/.versions/<recorded-version>/<artifact-path>`
- *installed copy* — read from the target path in the workspace
- *source @ current* — read from `<source-root>/<artifact-path>`

If the recorded snapshot is missing (unpublished local build, or a version older than the snapshot retention), fall back to "treat installed copy as canonical" — do not pretend a diff exists. Mention the missing snapshot in the row's status text so the user can decide.

After the table, ask: *"Which items in this group? — adjust the picks, or reply `all` / `recommended` / `none` / `keep` (keep the pre-selection as shown)."* `recommended` ticks every `★` item **in addition to** the already-installed pre-selection (so the user never accidentally removes installed items by accepting recommendations). `keep` is the no-change shortcut.

For an already-configured workspace, an **unchecked installed item means *remove it*** (subject to the removal-scope rule); a **checked one means *keep or update it***. Status text appears verbatim for every row — even `not installed` — so the user always sees an explicit state instead of inferring it from an empty checkbox.

**Source availability filter — never substitute across agents.** Each row is offered only when the source file the **chosen agent** needs already exists in this repo. The source location is fixed per agent:

| Artifact | claude-code source | opencode source | pi source |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| Personas | `agents/<name>.md` | `agents/<name>.md` | `agents/<name>.md` |
| Commands / prompts | `.claude/commands/<name>.md` | `.opencode/commands/as-<name>.md` | `.pi/prompts/<name>.md` |
| pi extensions / harnesses / runtime skills | — | — | `.pi/extensions/<name>/`, `.pi/harnesses/<name>/`, `.pi/skills/<name>/` |
| References / hooks | source files in `references/` / `hooks/` |

If the per-agent source is missing, the row is **not shown** — never silently fall back to a different agent's tree (for example: do not symlink `.claude/commands/design-agent.md` from `.pi/prompts/design-agent.md` when the agent is `pi`). When the user explicitly asks for an item the source lacks for their agent, say so plainly and stop; the answer is to author the missing source file first, not to cross-link runtimes.

Groups, in order:

1. **Skills — Define / Plan** — `spec-driven-development` ★, `planning-and-task-breakdown` ★, `idea-refine`
2. **Skills — Build** — `incremental-implementation` ★, `test-driven-development` ★, `context-engineering`, `source-driven-development`, `frontend-ui-engineering`, `api-and-interface-design`
3. **Skills — Verify** — `browser-testing-with-devtools`, `debugging-and-error-recovery` ★
4. **Skills — Review** — `code-review-and-quality` ★, `code-simplification`, `security-and-hardening`, `performance-optimization`
5. **Skills — Ship** — `git-workflow-and-versioning` ★, `ci-cd-and-automation`, `deprecation-and-migration`, `documentation-and-adrs`, `shipping-and-launch`
6. **Skills — Meta** — `using-agent-skills` ★, `designing-agents` *(`guided-workspace-setup` is installer-only — never offered)*
7. **Agent personas — writeable** — `builder`, `documenter`
8. **Agent personas — read-only** (carry `tools: read,bash,grep,find,ls` and an explicit "Do NOT modify files." rule) — `code-reviewer` ★, `test-engineer` ★, `security-auditor`, `planner`, `plan-reviewer`, `scout`
9. **Commands / prompts** (mapped to the chosen agent — items without a per-agent source are filtered out, no cross-tool substitution) — full candidate list: `spec` ★, `plan` ★, `build` ★, `test` ★, `review` ★, `code-simplify`, `ship`, `design-agent`, `prime`. The actual menu shows only items whose per-agent source file exists — for example, `.pi/prompts/design-agent.md` and `.pi/prompts/prime.md` are absent, so neither is offered when the agent is `pi`. *(`setup` and `doctor` are installer-only — never offered, since they live in the source agent-skills repo and act on target workspaces from there.)*
10. **pi extensions** *(pi only — always-on once installed)* — `mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`, `agent-skills-update-check` ★
11. **pi harnesses — UI / status** *(pi only, mutually exclusive at runtime — install many, load one)* — `minimal`, `tool-counter`, `tool-counter-widget`, `session-replay`, `subagent-widget`
12. **pi harnesses — discipline / focus** *(pi only)* — `purpose-gate`, `tilldone`, `system-select`
13. **pi harnesses — safety** *(pi only)* — `damage-control`, `damage-control-continue`
14. **pi harnesses — orchestration** *(pi only)* — `agent-chain`, `agent-team`, `pi-pi`
15. **pi harnesses — messaging** *(pi only)* — `coms`, `coms-net`
16. **pi-runtime skills** *(pi only)* — `bowser`
17. **References** — testing, performance, security, accessibility checklists
18. **Hooks** — `session-start.sh`, `simplify-ignore.sh` (+ `simplify-ignore-test.sh`)

Defaults differ by workspace state:

- **Fresh workspace (no install record).** Pre-selection is empty; replying `recommended` ticks the `★` items across groups 1–6, 7–8, 9. pi groups stay empty unless the agent is `pi`.
- **Existing workspace.** Pre-selection mirrors the install record — every `installed · *` row starts `[x]`. Replying `keep` accepts that pre-selection unchanged; replying `recommended` adds the `★` items on top of what is already installed (it never silently unticks installed items).

After every group, restate the picks in one line so the user can correct them before moving on. The restate line uses the same status vocabulary — for example: *"Group 4 Review: keep `code-review-and-quality` (up to date), install `security-and-hardening` (recommended), remove `performance-optimization`."*

**Removal scope — what "unchecked = remove" actually touches.** A target item is eligible for removal only when **both** are true:

1. **It is part of the agent-skills inventory.** Its name matches an artifact shipped in the source repo's canonical trees (`skills/`, `agents/`, `.claude/commands/`, `.pi/prompts/`, `.pi/extensions/`, `.pi/harnesses/`, `.pi/skills/`, `references/`, `hooks/`). Out-of-inventory items — user-authored skills, project-specific commands, custom personas, third-party plugins, unrelated dotfiles — are never proposed for removal even if they sit in the same directory.
2. **It is recorded in this workspace's install record.** The `## install-status` section of `.ai/agent-skills-setup.md` lists it as previously installed by this skill, *or* it is a symlink whose target resolves into the agent-skills source root (which is unambiguously ours).

If a candidate fails either test, list it once under a "Skipped — not owned by agent-skills" line in the Step 9 plan and leave it alone. Settings files (`.claude/settings.json`, `.opencode/config*`, env vars, MCP config) are touched **only** to remove agent-skills' own hook registrations — never other keys, never user env vars, never third-party MCP entries.

### 7. Offer project overrides

From the Step 4 analysis, propose draft override sections for `.ai/agent-skills-overrides.md` — `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`. Write each section as terse `key: value` lines, never prose: the lifecycle skills load this file on every run and parse it by key, so it stays minimal. Show the draft and let the user edit, accept, or skip each section. Reference env-var names for any credentials; keep secrets out of the file.

### 8. Choose the install method

Ask `copy` or `symlink` for this run.

- `copy` — copy each artifact into its target path.
- `symlink` — link each target path to the source artifact in the agent-skills repo.

### 9. Confirm the plan

Present the full set as one summary table — artifacts to add, update, and remove; their resolved target paths; the chosen install method; and the changes to both `.ai/` files. When the version delta from Step 4 is non-empty, lead the summary with a one-line "Changes since `v<recorded>` → `v<current>`" block sourced from `CHANGELOG.md` (only the entries between the two versions, not the full file). Ask the user to confirm, and write nothing until they do.

**Installer cleanup line.** The summary always ends with one line stating that the installer slash commands (`/setup-agent-skills`, `/doctor-agent-skills` — or `/as-*-agent-skills` for OpenCode — plus the `guided-workspace-setup` skill body) will be removed after apply, so they do not pollute the user's slash-command list. Add the verbatim suffix: *"Reply `keep` to leave them in place; re-run `npx @chankov/agent-skills init` later if removed."* If the user replies `keep`, record `keep-installer: true` in `## workspace-summary` and skip Step 10b. Otherwise the default is to remove them.

### 10. Apply the setup

Apply the changes: create directories, add or update selected artifacts, and remove deselected ones — **bound by the removal-scope rule from Step 6**. Before deleting any target, verify both conditions: (a) the name is in the agent-skills inventory and (b) the item is either listed in `## install-status` or is a symlink resolving into the source repo. If either check fails, skip the deletion silently and log the path under a "Skipped — not owned by agent-skills" line in the final report.

**Apply without mid-flight questions.** Refresh every ticked item from its per-agent source unconditionally. Do not pause to ask whether to overwrite a modified file — `installed · modified` already appeared in Step 6 with the explicit warning that refreshing overwrites local edits, and the user's tick is the consent. The Step 9 confirmation is the single gate; nothing further is asked during apply. (If the apply hits a genuine error — permission denied, source missing, broken target type — stop, report it, and ask how to proceed; that is not the same as soliciting consent.)

For settings files (`.claude/settings.json` and equivalents), edit only the agent-skills hook entries; leave every other key — user permissions, env vars, third-party MCP servers, custom hooks — untouched.

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

Re-scan the install-target directories one more time and confirm: every selected artifact exists at its target path, every deselected one is gone, and zero broken symlinks remain. Also re-read `.ai/agent-skills-setup.md` and verify the `version:` line matches the package version from Step 2 — a mismatch here means the apply pass did not stamp the new version, and must be corrected before the next re-run computes the wrong delta. If the post-apply scan surfaces any new breakage, treat it as a doctor finding and offer the same repair options as Step 5, then append a second `## doctor-runs` line with `phase: postflight`. List what changed, point the user at `.ai/agent-skills-overrides.md` and `.ai/agent-skills-setup.md`, and suggest loading `using-agent-skills` first in their next session.

Close the report with one line explaining the installer-cleanup outcome:

- If Step 10b ran: *"Installer slash commands removed from your workspace. Re-run `npx @chankov/agent-skills init` if you need `/setup-agent-skills` back."*
- If Step 10b was skipped (`keep-installer: true`): *"Installer slash commands kept in place per your choice. `/setup-agent-skills` and `/doctor-agent-skills` remain available."*

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The user wants everything — I'll install all skills without asking." | Loading every skill wastes context and dilutes discovery. The per-group menu and the `★` recommendations exist so a workspace gets only what it needs. |
| "I'll skip the doctor preflight — the menu will surface broken items anyway." | Broken symlinks distort the install menu's `installed` / `not installed` state. Repair first so the menu reflects reality. |
| "I'll collapse the groups into one big checklist — it's faster." | The groups are how the user reasons about scope (build vs review vs pi-only). A flat list makes recommendations meaningless. |
| "I'll copy the files now and confirm afterwards." | Writing before the Step 9 confirmation can clobber config the user wanted to keep. Confirmation is the only gate that protects the target workspace. |
| "There is no `*-setup.md` for this agent, so I'll guess the install paths." | Guessed paths put artifacts where the agent never loads them. Read the agent's setup doc, or use the built-in map — a location is never invented. |
| "The workspace already has a `.claude/` directory, so setup is done." | A directory existing is not install state. The `## install-status` section is the only record of what this skill installed; read it before deciding. |
| "An existing file differs from the source — I'll pause and ask the user mid-apply whether to overwrite." | Step 6 already surfaced `installed · modified` with the warning that refreshing overwrites local edits. The user's tick is the consent. Mid-apply questions break the apply pass; they were replaced by the upfront status. |
| "`.pi/prompts/design-agent.md` doesn't exist, but `.claude/commands/design-agent.md` does — I'll symlink to the Claude file so the user gets the prompt." | That mixes runtimes silently and lets the source repo's claude-code tree drive a pi target. The source availability filter forbids it: items without a per-agent source are not offered at all. |
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
- An install menu rendered as one undifferentiated list instead of the 18 grouped tables.
- A menu group rendered without per-row `Status` text, or with installed items not pre-checked.
- A `recommended` reply that silently unticks already-installed items instead of adding `★` items on top.
- `setup`, `doctor`, or `guided-workspace-setup` shown in the install menu — they are installer-only.
- An item offered for one agent whose per-agent source file does not exist (cross-tool substitution).
- A mid-apply prompt asking whether to overwrite a modified target file — that consent belongs in Step 6 / Step 9, not in Step 10.
- A target file or directory deleted whose name is not in the agent-skills inventory, or that is not recorded in `## install-status` and is not a symlink into the source repo.
- Edits to `settings.json` / env vars / MCP config beyond removing agent-skills' own hook registrations.
- An artifact installed to a path backed by neither the built-in map nor the agent's `*-setup.md`.
- `.ai/agent-skills-setup.md` left unchanged after artifacts were added or removed.
- Credentials or secrets written into either `.ai/` file.
- Every skill installed when the workspace needs a handful.
- An existing, differing target file overwritten without asking the user.
- A re-run that ignores the existing `## install-status` and reinstalls everything.
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
- [ ] Each install-menu group was presented as its own table + multi-select with `★` recommendations marked.
- [ ] Every row carried an explicit `Status` text (`installed · up to date`, `installed · outdated`, `installed · modified`, `not installed`, or `broken · skipped in preflight`) — never blank.
- [ ] Installed items were pre-checked `[x]`; not-installed items were pre-checked `[ ]`; `recommended` added `★` items on top of the pre-selection without unticking installed ones.
- [ ] Items lacking a per-agent source were filtered out of the menu — no cross-tool substitution offered.
- [ ] Apply ran without any overwrite-this-file prompt; ticked items refreshed unconditionally and unticked modified items were preserved.
- [ ] `setup`, `doctor`, and `guided-workspace-setup` were excluded from the install menu.
- [ ] Every selected artifact exists at its resolved target path; every deselected one was removed **only if** the removal-scope rule allowed it (in inventory + in install record / symlink-into-source).
- [ ] Out-of-inventory and unrecorded items found in the install-target directories were left untouched and logged under "Skipped — not owned by agent-skills".
- [ ] Settings-file edits were limited to agent-skills' own hook entries; no user keys, env vars, or third-party MCP entries were modified.
- [ ] `.ai/agent-skills-overrides.md` holds the agreed override sections as terse `key: value` lines, and nothing else.
- [ ] `.ai/agent-skills-setup.md` holds an up-to-date install record, including at least one `## doctor-runs` entry for this session, and a `version:` line in `## workspace-summary` that matches the package version from Step 2.
- [ ] When the version delta was non-empty, Step 9's summary led with the "Changes since v<recorded> → v<current>" block sourced from `CHANGELOG.md`.
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
