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

Resolve three things. Accept any already supplied in the invocation; otherwise ask.

- **Source root** — the agent-skills repo. Derive it from this `SKILL.md`'s own location: `skills/guided-workspace-setup/` sits two levels below the repo root.
- **Workspace path** — the target project to configure. Confirm the path exists and is a directory; stop and ask again if it does not.
- **Coding agent** — `claude-code`, `opencode`, or `pi`. Detect the running agent from the runtime, show it to the user, and let them choose a different one.

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
- Existing `.ai/agent-skills-setup.md` — read its `## install-status` section to learn what is already installed
- An existing `.ai/agent-skills-setup.md` (or any populated agent directory) means this workspace has prior state — flag it for Step 5

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

The doctor scan is also exposed standalone as `/doctor` — running it outside a setup pass is this same scan-and-repair flow without the rest of the install menu.

### 6. Present the install menu

Offer every installable artifact, split into the groups below. **Each group is its own multi-select prompt** so the user can pick at the finest granularity. Within a group, render the items as a markdown table using this fixed format:

| Pick | Item | Status | Rec | Purpose |
|---|---|---|---|---|
| `[ ]` | `<name>` | `installed` / `not installed` / `modified` / `broken` | `★` if recommended, else blank | one-line purpose |

After the table, ask: *"Which items in this group? — pick any, or reply `all` / `recommended` / `none`."* Default to the `★` items when the user accepts the recommendation without picking. For an already-configured workspace, an **unchecked installed item means *remove it*; a checked one means *keep or update it***. Carry over any `broken` items the user skipped in Step 5 so they can be re-confronted here.

Groups, in order:

1. **Skills — Define / Plan** — `spec-driven-development` ★, `planning-and-task-breakdown` ★, `idea-refine`
2. **Skills — Build** — `incremental-implementation` ★, `test-driven-development` ★, `context-engineering`, `source-driven-development`, `frontend-ui-engineering`, `api-and-interface-design`
3. **Skills — Verify** — `browser-testing-with-devtools`, `debugging-and-error-recovery` ★
4. **Skills — Review** — `code-review-and-quality` ★, `code-simplification`, `security-and-hardening`, `performance-optimization`
5. **Skills — Ship** — `git-workflow-and-versioning` ★, `ci-cd-and-automation`, `deprecation-and-migration`, `documentation-and-adrs`, `shipping-and-launch`
6. **Skills — Meta** — `using-agent-skills` ★, `designing-agents`, `guided-workspace-setup`
7. **Agent personas — writeable** — `builder`, `documenter`
8. **Agent personas — read-only** (carry `tools: read,bash,grep,find,ls` and an explicit "Do NOT modify files." rule) — `code-reviewer` ★, `test-engineer` ★, `security-auditor`, `planner`, `plan-reviewer`, `scout`
9. **Commands / prompts** (mapped to the chosen agent) — `spec` ★, `plan` ★, `build` ★, `test` ★, `review` ★, `code-simplify`, `ship`, `design-agent`, `prime`, `setup`, `doctor`
10. **pi extensions** *(pi only — always-on once installed)* — `mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`
11. **pi harnesses — UI / status** *(pi only, mutually exclusive at runtime — install many, load one)* — `minimal`, `tool-counter`, `tool-counter-widget`, `session-replay`, `subagent-widget`
12. **pi harnesses — discipline / focus** *(pi only)* — `purpose-gate`, `tilldone`, `system-select`
13. **pi harnesses — safety** *(pi only)* — `damage-control`, `damage-control-continue`
14. **pi harnesses — orchestration** *(pi only)* — `agent-chain`, `agent-team`, `pi-pi`
15. **pi harnesses — messaging** *(pi only)* — `coms`, `coms-net`
16. **pi-runtime skills** *(pi only)* — `bowser`
17. **References** — testing, performance, security, accessibility checklists
18. **Hooks** — `session-start.sh`, `simplify-ignore.sh` (+ `simplify-ignore-test.sh`)

Recommended defaults across a new workspace, when the user accepts without customising: groups 1–6 `★` items, groups 7–8 `★` items, group 9 `★` items. pi groups default to none unless the agent is `pi`. After every group, restate the picks in one line so the user can correct them before moving on.

### 7. Offer project overrides

From the Step 4 analysis, propose draft override sections for `.ai/agent-skills-overrides.md` — `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`. Write each section as terse `key: value` lines, never prose: the lifecycle skills load this file on every run and parse it by key, so it stays minimal. Show the draft and let the user edit, accept, or skip each section. Reference env-var names for any credentials; keep secrets out of the file.

### 8. Choose the install method

Ask `copy` or `symlink` for this run.

- `copy` — copy each artifact into its target path.
- `symlink` — link each target path to the source artifact in the agent-skills repo.

### 9. Confirm the plan

Present the full set as one summary table — artifacts to add, update, and remove; their resolved target paths; the chosen install method; and the changes to both `.ai/` files. Ask the user to confirm, and write nothing until they do.

### 10. Apply the setup

Apply the changes: create directories, add or update selected artifacts, and remove deselected ones. When an existing target file differs from the source, surface the difference and ask before replacing it. Then write both `.ai/` files: the agreed override sections from Step 7 into `.ai/agent-skills-overrides.md`, and the install record — artifacts, target paths, method, date — into `.ai/agent-skills-setup.md`.

### 11. Verify and report

Re-scan the install-target directories one more time and confirm: every selected artifact exists at its target path, every deselected one is gone, and zero broken symlinks remain. If the post-apply scan surfaces any new breakage, treat it as a doctor finding and offer the same repair options as Step 5, then append a second `## doctor-runs` line with `phase: postflight`. List what changed, point the user at `.ai/agent-skills-overrides.md` and `.ai/agent-skills-setup.md`, and suggest loading `using-agent-skills` first in their next session.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The user wants everything — I'll install all skills without asking." | Loading every skill wastes context and dilutes discovery. The per-group menu and the `★` recommendations exist so a workspace gets only what it needs. |
| "I'll skip the doctor preflight — the menu will surface broken items anyway." | Broken symlinks distort the install menu's `installed` / `not installed` state. Repair first so the menu reflects reality. |
| "I'll collapse the groups into one big checklist — it's faster." | The groups are how the user reasons about scope (build vs review vs pi-only). A flat list makes recommendations meaningless. |
| "I'll copy the files now and confirm afterwards." | Writing before the Step 9 confirmation can clobber config the user wanted to keep. Confirmation is the only gate that protects the target workspace. |
| "There is no `*-setup.md` for this agent, so I'll guess the install paths." | Guessed paths put artifacts where the agent never loads them. Read the agent's setup doc, or use the built-in map — a location is never invented. |
| "The workspace already has a `.claude/` directory, so setup is done." | A directory existing is not install state. The `## install-status` section is the only record of what this skill installed; read it before deciding. |
| "An existing file differs from the source, so I'll overwrite it to be safe." | The differing file may be a deliberate local edit. Surface the difference and ask; a silent overwrite destroys the user's work. |
| "I'll skip the workspace analysis and just ask the user everything." | The analysis is what makes the override offer accurate. Asking blind produces an overrides file the user has to hand-correct afterwards. |
| "I'll record the full install detail in the overrides file too — one place is simpler." | Other skills load the overrides file on every run. Install detail belongs only in `agent-skills-setup.md`; padding the overrides file taxes every later session. |

## Red Flags

- Files written to the target workspace before the Step 9 confirmation.
- The doctor preflight skipped on a workspace that already has prior install state.
- An install menu rendered as one undifferentiated list instead of the 18 grouped tables.
- An artifact installed to a path backed by neither the built-in map nor the agent's `*-setup.md`.
- `.ai/agent-skills-setup.md` left unchanged after artifacts were added or removed.
- Credentials or secrets written into either `.ai/` file.
- Every skill installed when the workspace needs a handful.
- An existing, differing target file overwritten without asking the user.
- A re-run that ignores the existing `## install-status` and reinstalls everything.
- The overrides file padded with install status, summaries, or prose instead of terse `key: value` sections.

## Verification

After completing the workflow, confirm:

- [ ] The workspace path was validated as an existing directory before any write.
- [ ] The coding agent was confirmed, and `docs/<agent>-setup.md` was read for `opencode`/`pi` (or the built-in map used for `claude-code`).
- [ ] The doctor preflight ran on any workspace with prior install state, and its findings were resolved or explicitly skipped.
- [ ] Each install-menu group was presented as its own table + multi-select with `★` recommendations marked.
- [ ] Every selected artifact exists at its resolved target path; every deselected one was removed.
- [ ] `.ai/agent-skills-overrides.md` holds the agreed override sections as terse `key: value` lines, and nothing else.
- [ ] `.ai/agent-skills-setup.md` holds an up-to-date install record, including at least one `## doctor-runs` entry for this session.
- [ ] No broken symlinks remain in any of the scanned install-target directories.
- [ ] No YAML config references a removed persona name.
- [ ] No secrets were written to either `.ai/` file.
- [ ] The user confirmed the plan in Step 9 before any file was written.
