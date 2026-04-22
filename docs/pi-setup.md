# pi Setup

This guide explains how to use Agent Skills with [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the terminal coding agent from `pi-mono`. Unlike some harnesses, pi has a **native Agent Skills implementation**, so no prompt hacks are needed: this repo drops in directly.

## Overview

pi natively supports:

- `AGENTS.md` / `CLAUDE.md` context files (auto-loaded from cwd, parent dirs, and global config)
- Skill discovery from well-known directories (`.agents/skills/`, `.pi/skills/`, `~/.pi/agent/skills/`)
- Explicit skill invocation via `/skill:<name>`
- Automatic skill loading by the model when intent matches

This means you get near-parity with Claude Code:

- Skills are selected automatically based on intent
- Workflows are enforced via `AGENTS.md`
- Users can also explicitly trigger any skill with `/skill:<name>`

No plugin, wrapper, or custom system prompt is required.

---

## Installation

The recommended install is **project-scoped via `.agents/skills/` using a symlink**. pi walks upward from the current working directory looking for `.agents/skills/`, so once the symlink exists, every pi session started from inside (or below) the repo picks up the skills automatically. The `AGENTS.md` at the repo root is loaded the same way.

1. Clone the repository:

```bash
git clone https://github.com/chankov/agent-skills.git
cd agent-skills
```

2. Symlink `skills/` into a pi-discoverable path at the repo root:

```bash
mkdir -p .agents
ln -s "$PWD/skills" .agents/skills
```

3. Verify pi can see everything:

```bash
pi
# then type:
/skill:
# pi should autocomplete the full list of agent-skills
```

That's it. `AGENTS.md` is already at the repo root and is auto-loaded when pi starts.

### Keeping skills up to date

Because `.agents/skills` is a symlink into `skills/`, running `git pull` in the repo updates every skill in place — no re-copy required.

### Alternative scopes

- **Global install** — symlink into `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` to make skills available in every pi session on the machine, regardless of cwd.
- **Copy instead of symlink** — use `cp -R skills .agents/skills` if you're on a platform where symlinks are awkward (e.g. plain Windows without developer mode). You'll need to re-copy after updates.

### Future work

pi supports extensions and skill discovery "from pi packages." Publishing `agent-skills` as a first-class pi package would let users install via pi's own mechanism — out of scope for this guide, but tracked as a future integration.

---

## How It Works

### 1. Skill Discovery

pi searches these locations for skills (all are merged):

```
.agents/skills/           ← this install (walked upward from cwd)
.pi/skills/               ← project scope
~/.agents/skills/         ← global convention
~/.pi/agent/skills/       ← pi global config
<pi packages>             ← bundled/installed pi packages
```

Each skill lives in:

```
skills/<skill-name>/SKILL.md
```

### 2. Context Files

`AGENTS.md` (and `CLAUDE.md`) are auto-loaded and concatenated from:

- `~/.pi/agent/AGENTS.md` (global)
- Every parent directory walking up from cwd
- The current directory

The repo's `AGENTS.md` encodes the intent-to-skill mapping and workflow rules that make skill selection behave like Claude Code.

### 3. Invocation

Two ways to trigger a skill:

- **Explicit:** type `/skill:<name>` (e.g. `/skill:spec-driven-development`)
- **Automatic:** describe intent in natural language — the model reads `AGENTS.md` and loads the matching skill

### 4. Lifecycle Mapping

The development lifecycle is encoded in `AGENTS.md`:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`
- SHIP → `shipping-and-launch`

---

## Usage Examples

### Example 1: Feature Development

User:
```
Add authentication to this app
```

pi behavior:
- Reads `AGENTS.md`, detects feature work
- Auto-loads `spec-driven-development`
- Produces a spec before writing code
- Progresses to `planning-and-task-breakdown` and implementation skills

Equivalent explicit form:
```
/skill:spec-driven-development
```

---

### Example 2: Bug Fix

User:
```
This endpoint is returning 500 errors
```

pi behavior:
- Auto-loads `debugging-and-error-recovery`
- Reproduces → localizes → fixes → adds guards

Equivalent explicit form:
```
/skill:debugging-and-error-recovery
```

---

### Example 3: Code Review

User:
```
Review this PR
```

pi behavior:
- Auto-loads `code-review-and-quality`
- Applies structured review (correctness, design, readability, security, tests)

Equivalent explicit form:
```
/skill:code-review-and-quality
```

---

## Agent Expectations (Critical)

For the skill system to deliver its value, the agent must:

- Check whether a skill applies before acting
- Invoke the matching skill when one applies
- Never skip required workflows (spec, plan, test, etc.)
- Not jump directly to implementation on non-trivial work

These rules are enforced by `AGENTS.md`, which pi auto-loads.

---

## Verification

After installing, confirm the integration works:

1. Run `pi` from inside the repo (or any subdirectory).
2. Type `/skill:` and confirm the skill list autocompletes with entries like `spec-driven-development`, `incremental-implementation`, `code-review-and-quality`.
3. Ask: *"design a new feature for X"* — confirm pi invokes `spec-driven-development`.
4. Ask: *"fix this bug"* — confirm pi invokes `debugging-and-error-recovery`.

If autocomplete is empty, check that `.agents/skills` points to a directory containing `<skill-name>/SKILL.md` files and that pi was not started with `--no-skills`.

---

## Limitations

- Automatic skill loading depends on the underlying model's compliance with `AGENTS.md` rules.
- Windows without developer mode may not support symlinks — use the copy variant instead.
- Global `AGENTS.md` applies to every project when using the global-install alternative; pi concatenates context files, so this is usually additive, not destructive, but be aware of it.

---

## Recommended Workflow

Just use natural language:

- "Design a feature"
- "Plan this change"
- "Implement this"
- "Fix this bug"
- "Review this"

Or invoke explicitly when you want control:

- `/skill:spec-driven-development`
- `/skill:planning-and-task-breakdown`
- `/skill:incremental-implementation`
- `/skill:debugging-and-error-recovery`
- `/skill:code-review-and-quality`

---

## Summary

pi integration works by leveraging pi's **native** Agent Skills support:

- Symlink `skills/` into `.agents/skills/`
- Let pi auto-load `AGENTS.md` from the repo root
- Use `/skill:<name>` or natural language to trigger skills

The result is a fully agent-driven, production-grade engineering workflow — with zero configuration beyond a single symlink.
