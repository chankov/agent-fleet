# OpenCode Setup

This guide explains how to use Agent Fleet with OpenCode in a way that closely mirrors the Claude Code experience (automatic skill selection, lifecycle-driven workflows, and strict process enforcement).

## Overview

OpenCode supports custom `/commands`, but does not have a native plugin system or automatic skill routing like Claude Code.

Instead, we achieve parity through:

- A strong system prompt (`AGENTS.md`)
- The built-in `skill` tool
- Consistent skill discovery from the `/skills` directory
- Optional prefixed slash commands from `.opencode/commands/`

This creates an **agent-driven workflow** where skills are selected and executed automatically, with optional explicit lifecycle commands when you want them.

This integration defaults to an agent-driven approach:

- Skills are selected automatically based on intent
- Workflows are enforced via `AGENTS.md`
- Manual command invocation is optional, not required

This more closely matches how Claude Code behaves in practice, while still allowing explicit OpenCode slash commands.

---

## Installation

### Recommended — the `agent-fleet` CLI (project-scoped)

The CLI writes OpenCode's targets directly: `.opencode/skills/`, `.opencode/commands/`,
and `.opencode/agent/` (personas transformed to `mode: subagent` on the way in).

```bash
cd /path/to/your-project

# Guided: bootstraps the installer command, then run /af-setup-agent-fleet in OpenCode
npx @chankov/agent-fleet init --agent opencode

# Or straight to it — no agent, no model, no prompts:
npx @chankov/agent-fleet install --agent opencode --profile recommended --yes
npx @chankov/agent-fleet verify --agent opencode
```

Refresh after a package update with `npx @chankov/agent-fleet upgrade` — it
three-way merges against the version recorded in `.ai/agent-fleet-state.json`,
so your local edits survive and a genuine conflict lands beside your file as
`<file>.new` (exit `3`) instead of overwriting it. Artifacts install as **copies**;
`agent-fleet doctor --fix` repairs anything that goes missing or dangling.

Profiles: `minimal`, `recommended`, `full`. Narrow it with
`--items skill:code-review-and-quality,command:review,persona:code-reviewer`, and
preview any verb with `--dry-run`. Full reference: [npm-install.md](npm-install.md).

### Manual global install (advanced)

Use this only when you want the skills available in **every** OpenCode session on
the machine regardless of project — the CLI installs per workspace and does not
write to `~/.config/opencode/`.

1. Clone the repository:

```bash
git clone https://github.com/chankov/agent-fleet.git
```

2. Install the global OpenCode configuration.

Set `AGENT_SKILLS_DIR` to wherever you cloned the repo (used in the snippets below):

```bash
export AGENT_SKILLS_DIR="/path/to/agent-fleet"
```

Add the repo's `AGENTS.md` to your global `~/.config/opencode/opencode.json` instructions list (replace `/path/to/agent-fleet` with the absolute path on your machine — `~` is not expanded inside JSON):

```json
{
  "instructions": [
    "/path/to/agent-fleet/AGENTS.md"
  ],
  "permission": {
    "skill": {
      "*": "allow"
    }
  }
}
```

Link the skills and commands into your global OpenCode config directory. Symlinking individual files (rather than the whole directory) avoids replacing skills or commands you may already have installed from other sources:

```bash
mkdir -p ~/.config/opencode/skills ~/.config/opencode/commands

# Skills: link each skill directory individually.
for d in "$AGENT_SKILLS_DIR"/skills/*/; do
  ln -s "$d" "$HOME/.config/opencode/skills/$(basename "$d")"
done

# Commands: link each command file individually.
for f in "$AGENT_SKILLS_DIR"/.opencode/commands/*.md; do
  ln -s "$f" "$HOME/.config/opencode/commands/$(basename "$f")"
done
```

> ⚠️ If you already have `~/.config/opencode/skills` or `~/.config/opencode/commands` populated from other sources, do **not** replace the whole directory — use the per-file symlink approach above. The previous `ln -sfn <dir>` shortcut would silently overwrite the existing directory.

3. Restart OpenCode.

4. Open any project in OpenCode.

5. The following Agent Fleet assets are now available globally:

- `AGENTS.md` instructions from the repo root
- All skills from `skills/`
- Optional prefixed slash commands from `.opencode/commands/`

### Optional Slash Commands

This repo ships OpenCode-native commands with an `af-` prefix so they are easy to distinguish from other commands:

- `/af-spec`
- `/af-plan`
- `/af-build`
- `/af-test`
- `/af-review`
- `/af-code-simplify`
- `/af-ship`
- `/af-webperf`
- `/af-design-agent`
- `/af-orchestrate`
- `/af-prime`
- `/af-setup-agent-fleet`
- `/af-doctor-agent-fleet`
- `/af-set-hermes-telegram install|status|on|off …` — profile-aware Hermes liaison setup and bridge control

These commands are optional shortcuts. The agent can still invoke the correct skills automatically from plain natural-language requests.

---

## How It Works

### 1. Skill Discovery

All skills live in:

```
skills/<skill-name>/SKILL.md
```

OpenCode agents are instructed (via `AGENTS.md`) to:

- Detect when a skill applies
- Invoke the `skill` tool
- Follow the skill exactly

### 2. Automatic Skill Invocation

The agent evaluates every request and maps it to the appropriate skill.

Examples:

- "build a feature" → `incremental-implementation` + `test-driven-development`
- "design a system" → `spec-driven-development`
- "fix a bug" → `debugging-and-error-recovery`
- "review this code" → `code-review-and-quality`

The user does **not** need to explicitly request skills.

### 3. Lifecycle Mapping

The development lifecycle is encoded implicitly via `AGENTS.md` and is also exposed through optional prefixed slash commands. Both routes invoke the same underlying skills:

| Lifecycle phase | Claude Code command | OpenCode command   | Underlying skill(s)                                           |
| --------------- | ------------------- | ------------------ | ------------------------------------------------------------- |
| DEFINE          | `/spec`             | `/af-spec`         | `spec-driven-development`                                     |
| PLAN            | `/plan`             | `/af-plan`         | `planning-and-task-breakdown`                                 |
| BUILD           | `/build`            | `/af-build`        | `incremental-implementation` + `test-driven-development`      |
| TEST            | `/test`             | `/af-test`         | `test-driven-development`                                     |
| VERIFY          | —                   | —                  | `debugging-and-error-recovery` (implicit on failure)          |
| REVIEW          | `/review`           | `/af-review`       | `code-review-and-quality`                                     |
| SIMPLIFY        | `/code-simplify`    | `/af-code-simplify`| `code-simplification`                                         |
| SHIP            | `/ship`             | `/af-ship`         | `shipping-and-launch`                                         |
| WEBPERF         | `/webperf`          | `/af-webperf`      | `web-performance-auditor` persona (`performance-optimization`) |
| AUTHOR          | `/design-agent`     | `/af-design-agent` | `designing-agents`                                            |
| ORCHESTRATE     | `/orchestrate`      | `/af-orchestrate`  | `orchestration-verification`                                  |

---

## Usage Examples

### Example 1: Feature Development

User:
```
Add authentication to this app
```

Agent behavior:
- Detects feature work
- Invokes `spec-driven-development`
- Produces a spec before writing code
- Moves to planning and implementation skills

---

### Example 2: Bug Fix

User:
```
This endpoint is returning 500 errors
```

Agent behavior:
- Invokes `debugging-and-error-recovery`
- Reproduces → localizes → fixes → adds guards

---

### Example 3: Code Review

User:
```
Review this PR
```

Agent behavior:
- Invokes `code-review-and-quality`
- Applies structured review (correctness, design, readability, etc.)

---

## Agent Expectations (Critical)

For OpenCode to work correctly, the agent must follow these rules:

- Always check if a skill applies before acting
- If a skill applies, it MUST be used
- Never skip required workflows (spec, plan, test, etc.)
- Do not jump directly to implementation

These rules are enforced via `AGENTS.md`.

---

## Limitations

- No plugin system (handled via prompt + structure)
- Skill invocation depends on model compliance

Despite these, the workflow closely matches Claude Code in practice.

---

## Recommended Workflow

Just use natural language:

- "Design a feature"
- "Plan this change"
- "Implement this"
- "Fix this bug"
- "Review this"

The agent will automatically select and execute the correct skills.

If you prefer explicit entry points, use the shipped slash commands such as `/af-spec`, `/af-plan`, or `/af-review`.

---

## Summary

OpenCode integration works by combining:

- Structured skills (this repo)
- Strong agent rules (`AGENTS.md`)
- Automatic skill invocation via reasoning
- Optional `af-` prefixed slash commands for explicit lifecycle entry points

This results in a **production-grade engineering workflow** that works both as an agent-driven system and as an explicit command-driven workflow.
