# OpenCode Setup

This guide explains how to use Agent Skills with OpenCode in a way that closely mirrors the Claude Code experience (automatic skill selection, lifecycle-driven workflows, and strict process enforcement).

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

1. Clone the repository:

```bash
git clone https://github.com/chankov/agent-skills.git
```

2. Install the global OpenCode configuration.

Add the repo's `AGENTS.md` to your global `~/.config/opencode/opencode.json` instructions list:

```json
{
  "instructions": [
    "/home/nchankov/repos/agent-skills/AGENTS.md"
  ],
  "permission": {
    "skill": {
      "*": "allow"
    }
  }
}
```

Link or copy the skills and commands into your global OpenCode config directory:

```bash
mkdir -p ~/.config/opencode
ln -sfn /home/nchankov/repos/agent-skills/skills ~/.config/opencode/skills
ln -sfn /home/nchankov/repos/agent-skills/.opencode/commands ~/.config/opencode/commands
```

3. Restart OpenCode.

4. Open any project in OpenCode.

5. The following Agent Skills assets are now available globally:

- `AGENTS.md` instructions from the repo root
- All skills from `skills/`
- Optional prefixed slash commands from `.opencode/commands/`

### Optional Slash Commands

This repo ships OpenCode-native commands with an `as-` prefix so they are easy to distinguish from other commands:

- `/as-spec`
- `/as-plan`
- `/as-build`
- `/as-test`
- `/as-review`
- `/as-code-simplify`
- `/as-ship`
- `/as-design-sub-agent`

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

The development lifecycle is encoded implicitly:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`
- SHIP → `shipping-and-launch`

The same lifecycle is also exposed through the optional prefixed slash commands:

- `/as-spec` → `spec-driven-development`
- `/as-plan` → `planning-and-task-breakdown`
- `/as-build` → `incremental-implementation` + `test-driven-development`
- `/as-test` → `test-driven-development`
- `/as-review` → `code-review-and-quality`
- `/as-code-simplify` → `code-simplification`
- `/as-ship` → `shipping-and-launch`

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

If you prefer explicit entry points, use the shipped slash commands such as `/as-spec`, `/as-plan`, or `/as-review`.

---

## Summary

OpenCode integration works by combining:

- Structured skills (this repo)
- Strong agent rules (`AGENTS.md`)
- Automatic skill invocation via reasoning
- Optional `as-` prefixed slash commands for explicit lifecycle entry points

This results in a **production-grade engineering workflow** that works both as an agent-driven system and as an explicit command-driven workflow.
