# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository. pi is the coding agent Agent Fleet installs for; Claude Code takes part only as a coms peer (see `docs/claude-code-coms-bridge.md`).

## Terminal File Links

- In terminal responses, link local files using descriptive Markdown link text and an absolute `file:///` URL, e.g. `[Agent guide](file:///absolute/path/to/AGENTS.md)`. Do not use relative Markdown link targets or show bare paths instead of named links. This avoids Zed/macOS opening errors.

## Repository Overview

Agent Fleet is a Pi-centered multi-agent orchestration system (agent-hub dispatcher, herdr fleet control plane, coms peer messaging, Hermes remote control) with a library of lifecycle skills and agent personas for Pi.

## Project Philosophy

Read [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) before proposing or revising Agent
Fleet plans, architecture, or process changes. It is the canonical project
direction: deterministic lifecycle control, proportional workflows, adaptive
model assistance, and evidence-based completion. Plans and design reviews must
include a proportionate alignment note and distinguish current guarantees from
proposed behavior. Surface conflicts for a maintainer decision rather than
silently changing these principles.

## Skill-Driven Execution

### Core Rules

- If a task matches a skill, you MUST invoke it
- Read `skills/<skill-name>/SKILL.md` first. If absent, read
  `vendor/agent-skills-upstream/skills/<skill-name>/SKILL.md`. See
  [native-first skill discovery](docs/UPSTREAM-SKILLS.md#layout-and-precedence).
- Never implement directly if a skill applies
- Always follow the skill instructions exactly (do not partially apply them)

### Intent → Skill Mapping

The agent should automatically map user intent to skills:

- Feature / new functionality → `spec-driven-development`, then `incremental-implementation`, `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or interface design → `api-and-interface-design`
- UI work → `frontend-ui-engineering`

### Lifecycle Mapping

The agent should internally follow this lifecycle and invoke the matching skill at each phase:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`
- SHIP → `shipping-and-launch`

This lifecycle is normally implicit — the agent maps user intent to the right skill without being asked.

The repo also ships slash commands as explicit lifecycle entry points, `af-`-prefixed
in `.pi/prompts/`:

- `/af-spec` → `spec-driven-development`
- `/af-plan` → `planning-and-task-breakdown`
- `/af-build` → `incremental-implementation` + `test-driven-development`
- `/af-test` → `test-driven-development`
- `/af-review` → `code-review-and-quality`
- `/af-code-simplify` → `code-simplification`
- `/af-ship` → `shipping-and-launch`

Workspace installation is outside the prompt/skill layer: use the deterministic
`agent-fleet setup`, `agent-fleet doctor`, and `agent-fleet uninstall` CLI commands.

Whether triggered implicitly or via a command, the agent MUST invoke the underlying skill — never inline the steps.

### Execution Model

For every request:

1. Determine if any skill applies (even 1% chance)
2. Invoke the appropriate skill
3. Follow the skill workflow strictly
4. Only proceed to implementation after required steps (spec, plan, etc.) are complete

### Anti-Rationalization

The following thoughts are incorrect and must be ignored:

- "This is too small for a skill"
- "I can just quickly implement this"
- "I’ll gather context first"

Correct behavior:

- Always check for and use skills first

This keeps workflow enforcement identical across every supported runtime.

## Orchestration: Personas, Skills, and Commands

This repo has three composable layers. They have different jobs and should not be confused:

- **Skills** define workflows with steps and exit criteria. Invoke the matching skill from its `SKILL.md`.
- **Personas** (`agents/<role>.md`) — roles with a perspective and an output format. The *who*.
- **Slash commands** (`.pi/prompts/af-*.md`) — user-facing entry points. The *when*. The orchestration layer.

Composition rule: **the user (or a slash command) is the orchestrator. Personas do not invoke other personas.** A persona may invoke skills.

The multi-persona pattern this repo endorses in a plain session is **parallel fan-out with a merge step** — used by `/af-ship` to run `code-reviewer`, `security-auditor`, and `test-engineer` concurrently and synthesize their reports. Do not build a "router" persona that decides which other persona to call; that's the job of slash commands and intent mapping. The `agent-hub` harness is the sanctioned exception: the generated dispatcher prompt dispatches specialists under a Verification Contract, with that orchestration living in the harness rather than a peer persona calling another.

See [docs/agents.md](docs/agents.md) for the decision matrix and [references/orchestration-patterns.md](references/orchestration-patterns.md) for the full pattern catalog.

**Claude Code interop:** a Claude Code pane joins a fleet as a coms peer, not as a persona host. It carries no persona file — `runner: claude-code` in `.pi/agents/peers.yaml` spawns the CLI plus `.pi/agent-fleet/scripts/coms-claude-bridge.ts`, and the peer's name is what other agents address. `.pi/agents/dispatch-policy.yaml` can then route an agent-hub team member's `dispatch_agent` call to that live peer. See `docs/claude-code-coms-bridge.md`.

## Creating a New Skill

Follow the [skill authoring guide](docs/skill-anatomy.md) for the template,
optional helpers, distribution, and verification.
