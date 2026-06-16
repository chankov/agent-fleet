# pi Setup

This guide explains how to use Agent Skills with [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the terminal coding agent from `pi-mono`. Unlike some harnesses, pi has a **native Agent Skills implementation**, so no prompt hacks are needed for skills: this repo drops in directly.

This repo also ships pi-native **prompt templates** for the lifecycle slash commands (`/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, `/ship`). These commands add workflow orchestration on top of the underlying skills.

## Overview

pi natively supports:

- `AGENTS.md` / `CLAUDE.md` context files (auto-loaded from cwd, parent dirs, and global config)
- Skill discovery from well-known directories (`.agents/skills/`, `.pi/skills/`, `~/.pi/agent/skills/`)
- Explicit skill invocation via `/skill:<name>`
- Automatic skill loading by the model when intent matches
- Prompt-template slash commands from `.pi/prompts/*.md`

This means you get near-parity with Claude Code:

- Skills are selected automatically based on intent
- Workflows are enforced via `AGENTS.md`
- Users can explicitly trigger any skill with `/skill:<name>`
- Users can start lifecycle workflows with `/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, and `/ship`

No plugin, wrapper, or custom system prompt is required for the core workflow.

**Recommended companion package:** [`pi-ask-user`](https://github.com/edlsh/pi-ask-user) adds an interactive `ask_user` tool and bundles an `ask-user` skill. It is bundled automatically when you install `@chankov/agent-skills` as a pi package; clone/symlink setups should install it separately.

---

## Installation

There are two supported pi paths.

### First-class pi package (recommended for users)

Install this package directly with pi:

```bash
# Project-scoped (recommended for repositories)
pi install -l npm:@chankov/agent-skills

# Or global, if you want it in every pi session
pi install npm:@chankov/agent-skills
```

The npm pi package includes this repo's core skills, pi runtime skills, lifecycle prompts, and the bundled `pi-ask-user` package. That means `ask_user` and the `ask-user` skill are available from the same install; do not install `pi-ask-user` a second time unless you intentionally want a separate user/project package entry.

This package's pi manifest is intentionally conservative: it exposes skills, `.pi/skills`, `.pi/prompts`, and bundled `pi-ask-user` resources. It does **not** auto-expose this repo's `.pi/extensions` or harnesses, because those have their own runtime dependency setup and should still be installed explicitly through guided setup or the manual extension steps below.

### Clone / symlink setup (recommended for contributors)

The manual clone install is **project-scoped using symlinks**:

- `.agents/skills/` exposes the skills.
- `.pi/prompts/` exposes the lifecycle slash commands.

pi walks upward from the current working directory looking for project configuration, so once the symlinks exist, every pi session started from inside (or below) the repo picks up the skills and commands automatically. The `AGENTS.md` at the repo root is loaded the same way.

1. Clone the repository somewhere stable:

```bash
git clone https://github.com/chankov/agent-skills.git /path/to/agent-skills
```

2. From the project where you want to use the skills, symlink `skills/` into a pi-discoverable path:

```bash
cd /path/to/your-project
mkdir -p .agents
ln -s /path/to/agent-skills/skills .agents/skills
```

3. From the same project, symlink the pi-native lifecycle commands into pi's prompt-template directory:

```bash
mkdir -p .pi
ln -s /path/to/agent-skills/.pi/prompts .pi/prompts
```

This exposes:

```text
/spec
/plan
/build
/test
/review
/code-simplify
/ship
```

If `.pi/prompts` already exists as a real directory, keep it and symlink the individual command files instead:

```bash
ln -s /path/to/agent-skills/.pi/prompts/spec.md .pi/prompts/spec.md
ln -s /path/to/agent-skills/.pi/prompts/plan.md .pi/prompts/plan.md
ln -s /path/to/agent-skills/.pi/prompts/build.md .pi/prompts/build.md
ln -s /path/to/agent-skills/.pi/prompts/test.md .pi/prompts/test.md
ln -s /path/to/agent-skills/.pi/prompts/review.md .pi/prompts/review.md
ln -s /path/to/agent-skills/.pi/prompts/code-simplify.md .pi/prompts/code-simplify.md
ln -s /path/to/agent-skills/.pi/prompts/ship.md .pi/prompts/ship.md
```

4. Install the recommended `pi-ask-user` pi package separately (clone/symlink setup only):

```bash
# Project-scoped; records the companion package in .pi/settings.json
pi install -l npm:pi-ask-user

# Or global, if your pi setup is global
pi install npm:pi-ask-user
```

Skip this step if `pi list` already shows `pi-ask-user`, or if you installed `@chankov/agent-skills` via `pi install npm:@chankov/agent-skills` (it bundles `pi-ask-user`). This companion is a pi package, not a file copied from this repo.

5. Verify pi can see everything:

```bash
pi
# then type:
/skill:
# pi should autocomplete the full list of agent-skills, plus ask-user if pi packages are enabled

# then type:
/
# pi should autocomplete /spec, /plan, /build, /test, /review, /code-simplify, and /ship
```

That's it. `AGENTS.md` is already at the repo root and is auto-loaded when pi starts.

### Optional: pi extensions

This repo also ships pi **extensions** under `.pi/extensions/`. Extensions are TypeScript modules that register tools and commands directly with pi. They come in two kinds: **always-on utilities** that layer onto any session, and selectable **harnesses** that reshape a whole session.

The always-on utilities:

- `mcp-bridge/` — a reusable factory that turns any stdio MCP server into a pi extension. This is a library consumed by wrapper extensions. Symlink it alongside wrappers so relative imports resolve; when pi discovers it directly, it intentionally registers no tools or commands by itself.
- `chrome-devtools-mcp/` — bridges the [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server into pi as native tools, unlocking the `browser-testing-with-devtools` skill on pi.
- `compact-and-continue/` — registers the `request_compaction` tool that queues pi context compaction to run after the current agent turn ends, optionally resuming work from a self-contained continuation prompt. Used by `/build` to offer a "Compact & continue" option at slice-approval time.
- `agent-skills-update-check/` — surfaces an "update available" banner once per session when `@chankov/agent-skills` has a newer published version than the one recorded in `.ai/agent-skills-setup.md`. Never blocks startup (soft 3s check); honors `AGENT_SKILLS_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI` opt-outs.
- `btw/` — adds the `/btw <task>` prompt command (and `Alt+Shift+B` shortcut): forks the current session into an in-process sub-session that inherits the full conversation as context, runs in the same cwd, and streams into a live modal with a follow-up composer. A compact result card lands in the main transcript at idle (kept out of the main agent's LLM context). See [.pi/extensions/btw/README.md](../.pi/extensions/btw/README.md).

To install, symlink the directories into your project's `.pi/extensions/`:

```bash
mkdir -p .pi/extensions
ln -s /path/to/agent-skills/.pi/extensions/mcp-bridge                .pi/extensions/mcp-bridge
ln -s /path/to/agent-skills/.pi/extensions/chrome-devtools-mcp       .pi/extensions/chrome-devtools-mcp
ln -s /path/to/agent-skills/.pi/extensions/compact-and-continue      .pi/extensions/compact-and-continue
ln -s /path/to/agent-skills/.pi/extensions/agent-skills-update-check .pi/extensions/agent-skills-update-check
ln -s /path/to/agent-skills/.pi/extensions/btw                       .pi/extensions/btw
```

Install the shared runtime dependencies used by the symlinked extensions once in the `agent-skills` clone:

```bash
cd /path/to/agent-skills/.pi/extensions
npm ci
# If this clone does not have package-lock.json yet, run: npm install
```

Because the project extensions are symlinks into the clone, these dependencies are reused by every project that links the same extension directories.

Verify by starting `pi` and running `/chrome_devtools-status` — expect `Chrome DevTools MCP connected. Registered N tool(s).`

#### Extension harnesses — orchestration, safety, messaging

This repo ships **4 supported session harnesses** ported or consolidated from [disler](https://github.com/disler)'s [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) project (MIT):

- **Orchestration** — `agent-hub` (dispatcher grid, specialist delegation, research helpers, persona gate, embedded coms)
- **Safety** — `damage-control`
- **Pi-to-Pi messaging** — `coms`, `coms-net`

Unlike the utilities above, each harness reshapes the entire pi session, and most are loaded one per session rather than all at once. The supported stack is `damage-control` before `agent-hub`, which the `just hub` recipes use by default. pi auto-discovers and loads *everything* under `.pi/extensions/`, so the harnesses deliberately live in a separate directory — **`.pi/harnesses/`** — which pi does *not* auto-discover. **Never copy or symlink a harness into `.pi/extensions/`**: that would load it on every plain `pi` run, and stacking all harnesses aborts startup (`coms` and `coms-net` register clashing CLI flags). Load a harness recipe explicitly instead — there is nothing to symlink:

```bash
# from the agent-skills clone, via the bundled justfile
just --list                       # list every harness recipe
just hub                          # launch the guarded consolidated multi-agent hub

# or directly, from anywhere — point pi -e at the guarded harness stack
pi -e /path/to/agent-skills/.pi/harnesses/damage-control/index.ts -e /path/to/agent-skills/.pi/harnesses/agent-hub/index.ts
```

The harnesses have their own runtime dependencies (`yaml`, `@sinclair/typebox`) declared in `.pi/harnesses/package.json` — separate from the extension deps above. Install both at once with `just install` from the clone, or run `npm ci` in `.pi/harnesses/` as well. The [pi extension catalog](pi-extensions.md) has the full list, per-extension `README.md` pointers, required environment variables (for `coms-net`), and what changed from upstream.

Each extension — utility or harness — has its own `README.md` describing what it provides.

> Why a generic `mcp-bridge` exists: pi does not yet have first-class MCP infrastructure. The bridge is a stopgap that lets pi consume MCP servers today; it will be deprecated once pi gains native MCP support.

### Keeping skills up to date

Because `.agents/skills`, `.pi/prompts`, and `.pi/extensions` are symlinks into the cloned `agent-skills` repo, running `git pull` in that clone updates every skill, lifecycle command, and extension in place — no re-copy required.

### Alternative scopes

- **Global install** — symlink skills into `~/.pi/agent/skills/` and prompts into `~/.pi/agent/prompts/` to make them available in every pi session on the machine, regardless of cwd. You may also symlink `AGENTS.md` into `~/.pi/agent/AGENTS.md` for global workflow context.
- **Copy instead of symlink** — use `cp -R /path/to/agent-skills/skills .agents/skills` and `cp -R /path/to/agent-skills/.pi/prompts .pi/prompts` if you're on a platform where symlinks are awkward (e.g. plain Windows without developer mode). You'll need to re-copy after updates.

### Recommended companion package

If you use clone/symlink setup, install `pi-ask-user` with `pi install -l npm:pi-ask-user` unless `pi list` already shows it. If you installed `@chankov/agent-skills` as a pi package, `pi-ask-user` is already bundled and exposed by this package. In both cases, pi discovers its bundled `ask-user` skill from a pi package, not from vendored files in this repo. This is a strong complement to `agent-skills` because it gives the agent a structured way to stop and ask for an explicit decision before:

- architectural or API trade-offs
- destructive or costly-to-reverse changes
- ambiguous requirements
- preference-dependent implementation choices

That matches the repo's current pi setup, where `ask-user` is available as a recommended decision-gating skill.

---

## How It Works

### 1. Skill Discovery

pi searches these locations for skills (all are merged):

```
.agents/skills/           ← this install (walked upward from cwd)
.pi/skills/               ← project scope
~/.agents/skills/         ← global convention
~/.pi/agent/skills/       ← pi global config
<pi packages>             ← bundled/installed pi packages (e.g. `pi-ask-user`)
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

### 3. Prompt Templates

pi also searches for prompt templates in:

```
.pi/prompts/*.md          ← this command install (walked upward from cwd)
~/.pi/agent/prompts/*.md  ← pi global command config
<pi packages>             ← bundled/installed pi packages
```

Each Markdown file becomes a slash command by filename. For example:

```
.pi/prompts/spec.md          → /spec
.pi/prompts/code-simplify.md → /code-simplify
```

These lifecycle commands are not replacements for skills. They are workflow entry points that add orchestration and tell the agent which skills to load and follow for the current phase.

### 4. Invocation

Three ways to trigger the workflow:

- **Explicit skill:** type `/skill:<name>` (e.g. `/skill:spec-driven-development`)
- **Lifecycle command:** type `/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, or `/ship`
- **Automatic:** describe intent in natural language — the model reads `AGENTS.md` and loads the matching skill

### 5. Lifecycle Mapping

The development lifecycle is encoded in both `AGENTS.md` and the pi prompt templates:

- DEFINE → `/spec` → `spec-driven-development`
- PLAN → `/plan` → `planning-and-task-breakdown`
- BUILD → `/build` → `incremental-implementation` + `test-driven-development`
- VERIFY → `/test` → `test-driven-development`; use `debugging-and-error-recovery` when tests or builds fail
- REVIEW → `/review` → `code-review-and-quality`
- SIMPLIFY → `/code-simplify` → `code-simplification`
- SHIP → `/ship` → `shipping-and-launch`

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

Equivalent explicit forms:
```
/spec Add authentication to this app
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

Equivalent explicit forms:
```
/test This endpoint is returning 500 errors
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

Equivalent explicit forms:
```
/review
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
2. Type `/skill:` and confirm the skill list autocompletes with entries like `spec-driven-development`, `incremental-implementation`, `code-review-and-quality`, and `ask-user`.
3. Type `/` and confirm the lifecycle commands autocomplete: `/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, and `/ship`.
4. Run `/spec design a new feature for X` — confirm pi expands the command and invokes `spec-driven-development`.
5. Ask: *"fix this bug"* — confirm pi invokes `debugging-and-error-recovery`, or run `/test` to start a TDD/debugging workflow explicitly.
6. Give pi an ambiguous or high-stakes request and confirm it can use the `ask_user` tool / `ask-user` skill to request an explicit decision.

If skill autocomplete is empty, check that `.agents/skills` points to a directory containing `<skill-name>/SKILL.md` files and that pi was not started with `--no-skills`.

If lifecycle command autocomplete is empty, check that `.pi/prompts` points to a directory containing the command Markdown files and run `/reload` or restart pi.

If extension loading reports `Cannot find module '@modelcontextprotocol/sdk/client/index.js'`, the extension runtime dependencies are not installed. Run:

```bash
cd /path/to/agent-skills/.pi/extensions
npm ci
```

The harnesses install separately — if a harness reports `Cannot find module 'yaml'` or `'@sinclair/typebox'`, run `npm ci` in `.pi/harnesses/` as well (or `just install` from the clone, which does both).

Then run `/reload` or restart pi.

---

## Limitations

- Automatic skill loading depends on the underlying model's compliance with `AGENTS.md` rules.
- Prompt-template commands expand into instructions; they do not mechanically execute `/skill:<name>`. The pi-specific prompt templates therefore explicitly tell the agent which skills to load and follow.
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

Or invoke lifecycle commands when you want the full workflow prompt:

- `/spec`
- `/plan`
- `/build`
- `/test`
- `/review`
- `/code-simplify`
- `/ship`

Or invoke individual skills directly when you want precise control:

- `/skill:spec-driven-development`
- `/skill:planning-and-task-breakdown`
- `/skill:incremental-implementation`
- `/skill:debugging-and-error-recovery`
- `/skill:code-review-and-quality`

---

## Summary

pi integration works by leveraging pi's **native** Agent Skills and prompt-template support:

- Symlink `skills/` into `.agents/skills/`
- Symlink `.pi/prompts/` into the target project's `.pi/prompts/`
- Install `@chankov/agent-skills` as a pi package for bundled `ask_user`, or install `pi-ask-user` separately for clone/symlink setup
- Let pi auto-load `AGENTS.md` from the repo root
- Use `/skill:<name>`, lifecycle commands like `/spec`, or natural language to trigger workflows

The result is a fully agent-driven, production-grade engineering workflow — with minimal setup: one symlink for this repo's skills, one symlink for lifecycle commands, plus bundled or separately installed `pi-ask-user` for interactive decision gating.
