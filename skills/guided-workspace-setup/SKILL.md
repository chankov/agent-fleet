---
name: guided-workspace-setup
description: Guides installation of agent-skills artifacts into a target workspace. Use when onboarding a project to agent-skills, when installing skills, commands, prompts, personas, or pi extensions for a chosen coding agent, or when a workspace needs its setup file configured.
---

# Guided Workspace Setup

## Overview

This skill installs and configures agent-skills artifacts — skills, agent personas, commands or prompts, pi extensions and harnesses, references, and hooks — into a target workspace for a chosen coding agent. It runs interactively, records what it installed in the target's `.ai/agent-skills-setup.md`, and can be re-run on the same workspace to add, update, or remove artifacts.

## When to Use

- Onboarding a new project or workspace to agent-skills
- Installing or changing which skills, commands, or personas a workspace uses
- Re-running setup to add, update, or remove already-installed artifacts
- Configuring a workspace's `.ai/agent-skills-setup.md` overrides

**NOT for:** authoring new skills or personas (use `designing-sub-agents`); editing artifacts inside the agent-skills repo itself; general context or rules-file tuning (use `context-engineering`).

## The Workflow

This skill is run from the agent-skills repo with the target coding agent active, and invoked with a path to the workspace to configure. Steps are gated — nothing is written to the target workspace until the user confirms in Step 8.

### 1. Detect interaction capability

Determine whether an interactive question or checkbox tool is available in the current runtime (for example `AskUserQuestion`).

- Available → use multi-select checkbox prompts for every selection step.
- Not available → ask one question at a time in chat. After each answer, restate it in one line so the user can correct it before the next question.

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

Scan the workspace to ground the recommendations and the setup file:

- Language, framework, and package manager (`package.json`, `go.mod`, `pyproject.toml`, …)
- Test runner and dev-server command, where discoverable
- Git presence and current branch
- Existing agent directories (`.claude/`, `.opencode/`, `.pi/`)
- Existing `.ai/agent-skills-setup.md` — read its `## install-status` section to learn what is already installed

Report a short summary of the findings before continuing.

### 5. Present the install menu

Offer every installable artifact, grouped, as checkboxes (or a numbered list in fallback mode). Mark each item's current state from Step 4: `installed`, `not installed`, or `modified`.

- **Skills** — the core skills, grouped by phase; recommend the minimal trio (`spec-driven-development`, `test-driven-development`, `code-review-and-quality`) for a new workspace.
- **Agent personas** — `code-reviewer`, `test-engineer`, `security-auditor`.
- **Commands / prompts** — mapped to the chosen agent.
- **pi extensions** and **pi harnesses** — shown only when the agent is `pi`.
- **References** and **hooks**.

For an already-configured workspace, an unchecked installed item means *remove it*; a checked one means *keep or update it*.

### 6. Offer setup-file overrides

From the Step 4 analysis, propose draft override sections for `.ai/agent-skills-setup.md` — `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`. Show the draft and let the user edit, accept, or skip each section. Reference env-var names for any credentials; keep secrets out of the file.

### 7. Choose the install method

Ask `copy` or `symlink` for this run.

- `copy` — copy each artifact into its target path.
- `symlink` — link each target path to the source artifact in the agent-skills repo.

### 8. Confirm the plan

Present the full set: artifacts to add, update, and remove; their resolved target paths; the chosen install method; and the setup-file changes. Ask the user to confirm, and write nothing until they do.

### 9. Apply the setup

Apply the changes: create directories, add or update selected artifacts, and remove deselected ones. When an existing target file differs from the source, surface the difference and ask before replacing it. Then write or update `.ai/agent-skills-setup.md` — refresh the `## install-status` section and merge in the override sections from Step 6.

### 10. Verify and report

Confirm every selected artifact exists at its target path, and every deselected one is gone. List what changed, point the user at `.ai/agent-skills-setup.md`, and suggest loading `using-agent-skills` first in their next session.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The user wants everything — I'll install all skills without asking." | Loading every skill wastes context and dilutes discovery. The menu and the minimal-trio recommendation exist so a workspace gets only what it needs. |
| "I'll copy the files now and confirm afterwards." | Writing before the Step 8 confirmation can clobber config the user wanted to keep. Confirmation is the only gate that protects the target workspace. |
| "There is no `*-setup.md` for this agent, so I'll guess the install paths." | Guessed paths put artifacts where the agent never loads them. Read the agent's setup doc, or use the built-in map — a location is never invented. |
| "The workspace already has a `.claude/` directory, so setup is done." | A directory existing is not install state. The `## install-status` section is the only record of what this skill installed; read it before deciding. |
| "An existing file differs from the source, so I'll overwrite it to be safe." | The differing file may be a deliberate local edit. Surface the difference and ask; a silent overwrite destroys the user's work. |
| "I'll skip the workspace analysis and just ask the user everything." | The analysis is what makes the override offer accurate. Asking blind produces a setup file the user has to hand-correct afterwards. |

## Red Flags

- Files written to the target workspace before the Step 8 confirmation.
- An artifact installed to a path backed by neither the built-in map nor the agent's `*-setup.md`.
- `.ai/agent-skills-setup.md` left unchanged after artifacts were added or removed.
- Credentials or secrets written into `.ai/agent-skills-setup.md`.
- Every skill installed when the workspace needs a handful.
- An existing, differing target file overwritten without asking the user.
- A re-run that ignores the existing `## install-status` and reinstalls everything.

## Verification

After completing the workflow, confirm:

- [ ] The workspace path was validated as an existing directory before any write.
- [ ] The coding agent was confirmed, and `docs/<agent>-setup.md` was read for `opencode`/`pi` (or the built-in map used for `claude-code`).
- [ ] Every selected artifact exists at its resolved target path; every deselected one was removed.
- [ ] `.ai/agent-skills-setup.md` exists in the workspace with an up-to-date `## install-status` section and the agreed override sections.
- [ ] No secrets were written to `.ai/agent-skills-setup.md`.
- [ ] The user confirmed the plan in Step 8 before any file was written.
