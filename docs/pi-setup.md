# pi Setup

This guide explains how to use Agent Fleet with [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the terminal coding agent from `pi-mono`. Unlike some harnesses, pi has a **native Agent Fleet implementation**, so no prompt hacks are needed for skills: this repo drops in directly. Optional `pi-codex-image-gen` support is credited to <https://github.com/jvm/pi-mono>.

This repo also ships pi-native **prompt templates** for the lifecycle slash commands (`/af-spec`, `/af-plan`, `/af-build`, `/af-test`, `/af-review`, `/af-code-simplify`, `/af-ship`). These commands add workflow orchestration on top of the underlying skills.

The specialist **personas** in `agents/` — including `web-performance-auditor` — are invoked directly as subagents. There is no `/af-webperf` prompt; run that audit by invoking the `web-performance-auditor` persona.

## Overview

pi natively supports:

- `AGENTS.md` / `CLAUDE.md` context files (auto-loaded from cwd, parent dirs, and global config)
- Skill discovery from well-known directories (`.agents/skills/`, `.pi/skills/`, `~/.pi/agent/skills/`)
- Explicit skill invocation via `/skill:<name>`
- Automatic skill loading by the model when intent matches
- Prompt-template slash commands from `.pi/prompts/*.md`

This gives you:

- Skills are selected automatically based on intent
- Workflows are enforced via `AGENTS.md`
- Users can explicitly trigger any skill with `/skill:<name>`
- Users can start lifecycle workflows with `/af-spec`, `/af-plan`, `/af-build`, `/af-test`, `/af-review`, `/af-code-simplify`, and `/af-ship`

No plugin, wrapper, or custom system prompt is required for the core workflow.

### Slash-command namespace

Agent Fleet owns the lowercase `/af-*` namespace on Pi. This keeps its prompt-template and harness commands distinct from Pi built-ins such as `/model` and `/settings`, skill invocations under `/skill:<name>`, and commands contributed by other installed packages. Examples: `/af-spec`, `/af-agents-list`, and `/af-allow`.

**Recommended companion packages:** [`pi-ask-user`](https://github.com/edlsh/pi-ask-user) adds an interactive `ask_user` tool and bundles an `ask-user` skill. It is bundled automatically when you install `@chankov/agent-fleet` as a pi package; clone setups should install it separately. `pi-codex-image-gen` is an optional suggested npm/pi extension for image generation; guided setup can offer it when package installation is available, but it is not bundled or required.

**Experimental phone conductor:** Linux users may pair Codex CLI `0.144.x` with ChatGPT Android to perform human-confirmed outbound delegation to live coms peers. Guided setup installs the repository assets when pi harnesses are selected, but deliberately never changes systemd, Codex auth/config, pairing, or service state. Host setup remains an explicit operator flow; see [Codex Remote-Control Conductor](codex-remote-conductor.md).

---

## Installation

There are three pi paths: the CLI installer (everything, per workspace), the
first-class pi package (skills + prompts, package-native), and a clone for
contributors. They compose — most pi users run the first two together.

### The `agent-fleet` CLI (recommended — this is what installs the fleet)

The CLI is the whole installer: it decides the paths, computes per-item state,
does the three-way merge, and performs every write. A complete install needs no
coding agent and no model.

```bash
cd /path/to/your-project

# Guided: bootstraps the installer command, then run /af-setup-agent-fleet in pi
npx @chankov/agent-fleet init --agent pi

# Or straight to it — no agent, no model, no prompts:
npx @chankov/agent-fleet install --agent pi --profile recommended --yes
npx @chankov/agent-fleet install --agent pi --profile pi-fleet-core --yes   # the harness stack
npx @chankov/agent-fleet verify --agent pi
```

Where it writes, for pi:

| Artifact | Target | Item id prefix |
|---|---|---|
| Skills | `.pi/skills/<name>/` | `skill:` |
| Lifecycle prompts | `.pi/prompts/af-<name>.md` | `command:` |
| Personas | `agents/<name>.md` (canonical, copied unchanged) | `persona:` |
| pi runtime skills | `.pi/skills/<name>/` | `pi-runtime-skill:` |
| Utility extensions | `.pi/extensions/<name>/` | `pi-extension:` |
| Session harnesses | `.pi/harnesses/<name>/` + the `justfile` managed region | `pi-harness:` |

Profiles: `minimal`, `recommended`, `full`, `pi-fleet-core` (`agent-hub`,
`damage-control-continue`, `ask-user-remote`, `coms`, plus the utilities the hub
expects), `hermes-plugins` and `codex-bridge` (both **operator-applied** — the plan
prints the exact commands for a human and the engine touches nothing outside the
workspace). Narrow any of them with `--items pi-harness:agent-hub,pi-extension:btw`,
and preview with `--dry-run`.

**Artifacts install as copies.** Keep them current with `agent-fleet upgrade`: it
three-way merges the version recorded in `.ai/agent-fleet-state.json` against the
installed copy and the current package, so a file you edited is preserved, and a
file that moved on both sides is a conflict — the incoming version is written as
`<file>.new`, yours is untouched, and the run exits `3`. `agent-fleet doctor --fix`
repairs missing or dangling items through the same write path a fresh install uses.

Removing a harness or extension is `agent-fleet uninstall --items pi-harness:coms`;
it refuses to strip something another installed item depends on (you cannot remove
`damage-control-continue` while `agent-hub` is installed), and removing the last pi
harness also strips the `agent-fleet:harnesses` region from the `justfile`.

Full CLI reference — every flag, every exit code, CI usage: [npm-install.md](npm-install.md).

### First-class pi package (skills and prompts, package-native)

Install this package directly with pi:

```bash
# Project-scoped (recommended for repositories)
pi install -l npm:@chankov/agent-fleet

# Or global, if you want it in every pi session
pi install npm:@chankov/agent-fleet
```

The npm pi package includes this repo's core skills, pi runtime skills, lifecycle prompts, and the bundled `pi-ask-user` package. That means `ask_user` and the `ask-user` skill are available from the same install; do not install `pi-ask-user` a second time unless you intentionally want a separate user/project package entry.

This package's pi manifest is intentionally conservative: it exposes skills, `.pi/skills`, `.pi/prompts`, and bundled `pi-ask-user` resources. It does **not** auto-expose this repo's `.pi/extensions` or harnesses, because those have their own runtime dependency setup and should still be installed explicitly through guided setup or the manual extension steps below. It also does **not** bundle or require `pi-codex-image-gen`; guided setup may suggest installing that external package with `pi install -l npm:pi-codex-image-gen` only when package installation is available and the user selects it.

### Clone setup (for contributors)

Clone when you want to **edit** the skills, personas, prompts, and harnesses
themselves. The clone is both the working tree and the install source: run its
own CLI and it installs from that checkout instead of from a published tarball.

1. Clone the repository somewhere stable and install its runtime deps:

```bash
git clone https://github.com/chankov/agent-fleet.git /path/to/agent-fleet
cd /path/to/agent-fleet
just install        # npm install for .pi/extensions/ and .pi/harnesses/
```

2. Install from the clone into a target project — same engine, same install
record, just a local source root:

```bash
node /path/to/agent-fleet/bin/cli.js install \
  --workspace /path/to/your-project --agent pi --profile recommended --yes
```

3. After editing the clone (or a `git pull`), push the changes out:

```bash
node /path/to/agent-fleet/bin/cli.js upgrade --workspace /path/to/your-project
```

**Inside the clone itself**, `--method symlink` is available — that is the one
workspace where editing an installed artifact is *meant* to edit the source.
Everywhere else it is refused: a link target can never move again, an npx cache
clean breaks every link at once, a `git pull` silently rewrites artifacts the
project never agreed to change, and Windows needs Developer Mode. A workspace
that recorded symlinks before this restriction is re-materialised as real files
on its next `install` or `upgrade`.

Whichever way you install, the prompts land in `.pi/prompts/` and expose:

```text
/af-spec
/af-plan
/af-build
/af-test
/af-review
/af-code-simplify
/af-ship
```

An existing `.pi/prompts/` directory is not a problem — the installer writes one
file per selected command and never replaces the directory. Anything it did not
write is not recorded, and therefore never removed or overwritten.

4. Install the recommended `pi-ask-user` pi package separately (clone setup only):

```bash
# Project-scoped; records the companion package in .pi/settings.json
pi install -l npm:pi-ask-user

# Or global, if your pi setup is global
pi install npm:pi-ask-user
```

Skip this step if `pi list` already shows `pi-ask-user`, or if you installed `@chankov/agent-fleet` via `pi install npm:@chankov/agent-fleet` (it bundles `pi-ask-user`). This companion is a pi package, not a file copied from this repo — the installer records it under `externalPackages` and tells you to run the command; it never runs a package install for you.

Optional image generation: guided setup can offer `pi-codex-image-gen` as a suggested external pi package when package installation is available, or you can install it manually:

```bash
pi install -l npm:pi-codex-image-gen
```

This package is not bundled by `@chankov/agent-fleet` and is not needed for minimal setup.

5. Verify pi can see everything:

```bash
pi
# then type:
/skill:
# pi should autocomplete the full list of agent-fleet, plus ask-user if pi packages are enabled

# then type:
/
# pi should autocomplete /af-spec, /af-plan, /af-build, /af-test, /af-review, /af-code-simplify, and /af-ship
```

That's it. `AGENTS.md` is already at the repo root and is auto-loaded when pi starts.

### Optional: pi extensions

This repo also ships pi **extensions** under `.pi/extensions/`. Extensions are TypeScript modules that register tools and commands directly with pi. They come in two kinds: **always-on utilities** that layer onto any session, and selectable **harnesses** that reshape a whole session.

The always-on utilities:

- `mcp-bridge/` — a reusable factory that turns any stdio MCP server into a pi extension. This is a library consumed by wrapper extensions; it is installed alongside the wrappers so relative imports resolve, and when pi discovers it directly it intentionally registers no tools or commands by itself.
- `chrome-devtools-mcp/` — bridges the [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server into pi as native tools, unlocking the `browser-testing-with-devtools` skill on pi.
- `compact-and-continue/` — registers the `request_compaction` tool that queues pi context compaction to run after the current agent turn ends, optionally resuming work from a self-contained continuation prompt. Used by `/af-build` to offer a "Compact & continue" option at slice-approval time.
- `agent-fleet-update-check/` — surfaces an "update available" banner once per session when `@chankov/agent-fleet` has a newer published version than the one recorded in `.ai/agent-fleet-setup.md`. Never blocks startup (soft 3s check); honors `AGENT_SKILLS_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI` opt-outs.
- `btw/` — adds the `/af-btw <task>` prompt command (and `Alt+'` shortcut): forks the current session into an in-process sub-session that inherits the full conversation as context, runs in the same cwd, and streams into a live modal with a follow-up composer. A compact result card lands in the main transcript at idle (kept out of the main agent's LLM context). See [.pi/extensions/btw/README.md](../.pi/extensions/btw/README.md).

Install them with the CLI — each is one item id:

```bash
npx @chankov/agent-fleet install --agent pi --allow-exec --yes \
  --items pi-extension:mcp-bridge,pi-extension:chrome-devtools-mcp,pi-extension:compact-and-continue,pi-extension:btw,pi-extension:agent-fleet-update-check
```

The extensions are copied into the project's own `.pi/extensions/`. Select
`mcp-bridge` explicitly whenever you take `chrome-devtools-mcp` — the wrapper
imports it by relative path, so the bridge has to sit beside it. A companion
carries the runtime dependencies: `.pi/extensions/package.json` +
`package-lock.json` are copied in, and `npm ci --prefix .pi/extensions` is run —
but only with **`--allow-exec`**, because running a command is a separate consent
class from writing files. Without that flag the plan lists the `npm ci` step and
skips it; run it yourself afterwards:

```bash
npm ci --prefix .pi/extensions
```

Each project gets its own copy and its own `node_modules`, so a `git pull` in some
other checkout can no longer change what this project loads.

Verify by starting `pi` and running `/af-chrome_devtools-status` — expect `Chrome DevTools MCP connected. Registered N tool(s).`

#### Extension harnesses — orchestration, safety, messaging

This repo ships **3 supported session harnesses** ported or consolidated from [disler](https://github.com/disler)'s [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) project (MIT):

- **Orchestration** — `agent-hub` (dispatcher grid, specialist delegation, research helpers, persona gate, embedded coms)
- **Safety** — `damage-control-continue` (fail-closed blocks feed back so the agent can report or safely adapt)
- **Pi-to-Pi messaging** — `coms` (launched guarded via `just fleet peer <name>`, and embedded in `just fleet hub`)

Unlike the utilities above, each harness reshapes the entire pi session, and most are loaded one per session rather than all at once. The supported stack loads `damage-control-continue` and `ask-user-remote` before `agent-hub`; the hub then re-loads continue into every native specialist, research helper, and nested delegate. Protected-path blocks can escalate for explicit approval, while dangerous command patterns remain non-exemptible. Missing child safety refuses dispatch. pi auto-discovers and loads *everything* under `.pi/extensions/`, so the harnesses deliberately live in a separate directory — **`.pi/harnesses/`** — which pi does *not* auto-discover. **Never copy or symlink a harness into `.pi/extensions/`**: that would load it on every plain `pi` run, and stacking all harnesses aborts startup (harnesses that register the same CLI flags clash). The installer already places them correctly:

```bash
npx @chankov/agent-fleet install --agent pi --profile pi-fleet-core --allow-exec --yes
```

That one profile pulls in `agent-hub`, its required `damage-control-continue` and
`ask-user-remote`, `coms`, and the utilities the hub expects — plus the
`agent-fleet:harnesses` region in the workspace `justfile` and the `.pi/agents/`
configs (`teams.yaml`, `peers.yaml`, `dispatch-policy.yaml`). Recipes you wrote
outside those sentinels are never touched. The one thing it does *not* do for you
is `pi-voice-stt`'s configuration: the extension is installed, and the plan prints
the operator steps (write `.ai/stt.json`, put the key in a gitignored `.env`) for
you to perform. Then load a harness explicitly:

```bash
# from the agent-fleet clone, via the bundled justfile
just fleet help                   # unified runtime grammar
just fleet                        # guarded Pi + STT and core utilities
just fleet hub                    # guarded consolidated multi-agent hub
just fleet team docs              # hub + guarded Herdr peer team
just --list                       # confirms the single public Fleet entry point

# or directly, from anywhere — point pi -e at the guarded harness stack
# Advanced/manual equivalent of only the harness part; `just fleet hub` also
# loads STT, Compact & Continue, BTW, and update-check as Fleet Core utilities.
pi -e /path/to/agent-fleet/.pi/harnesses/damage-control-continue/index.ts -e /path/to/agent-fleet/.pi/harnesses/ask-user-remote/index.ts -e /path/to/agent-fleet/.pi/harnesses/agent-hub/index.ts
```

**Upgrading from the retired hard-stop harness:** `.pi/harnesses/damage-control/` and
the old standalone damage-control recipes are no longer shipped. Run
`npx @chankov/agent-fleet upgrade` (or re-run guided setup, which calls it): only an
unchanged, recorded copy is removed and the managed `justfile` region is refreshed —
user-modified and unowned copies are preserved. Use `just fleet` for a standalone
guarded session.

The harnesses have their own runtime dependencies (`yaml`, `@sinclair/typebox`) declared in `.pi/harnesses/package.json` — separate from the extension deps above. `--allow-exec` runs `npm ci --prefix .pi/harnesses` for you as part of the install; without it, run that yourself (or `just install` from a clone, which does both roots). The [pi extension catalog](pi-extensions.md) has the full list, per-extension `README.md` pointers, required environment variables (for `chrome-devtools-mcp`), and what changed from upstream.

Each extension — utility or harness — has its own `README.md` describing what it provides.

> Why a generic `mcp-bridge` exists: pi does not yet have first-class MCP infrastructure. The bridge is a stopgap that lets pi consume MCP servers today; it will be deprecated once pi gains native MCP support.

### Keeping skills up to date

Everything the CLI installs is a copy, so refreshing is a command rather than a
`git pull` side effect:

```bash
npx @chankov/agent-fleet upgrade --dry-run   # what would change
npx @chankov/agent-fleet upgrade --yes
```

`upgrade` acts only on what the workspace already has — it never widens the
install. A newly catalogued skill or harness shows up as *available* in `verify`
and is added only by an explicit `install`. It also never eats a local edit: if
only the source moved you get a clean refresh, if only your copy moved it is
kept, and if both moved the incoming version lands as `<file>.new` and the run
exits `3` for you to resolve. Resolve non-interactively with `--accept-theirs`
or `--accept-ours`.

From a clone, the same thing with the clone as source root:

```bash
node /path/to/agent-fleet/bin/cli.js upgrade --workspace /path/to/your-project
```

### Alternative scopes

- **pi package, global** — `pi install npm:@chankov/agent-fleet` exposes the skills, `.pi/skills`, and lifecycle prompts to every pi session on the machine, regardless of cwd. This is the supported global path; the CLI installer is deliberately per-workspace and writes nothing to `~/.pi/`.
- **Global context file** — copy `AGENTS.md` to `~/.pi/agent/AGENTS.md` for machine-wide workflow context. pi concatenates context files, so this is additive to each project's own.

### Recommended companion packages

If you use clone setup, install `pi-ask-user` with `pi install -l npm:pi-ask-user` unless `pi list` already shows it. If you installed `@chankov/agent-fleet` as a pi package, `pi-ask-user` is already bundled and exposed by this package. In both cases, pi discovers its bundled `ask-user` skill from a pi package, not from vendored files in this repo. This is a strong complement to `agent-fleet` because it gives the agent a structured way to stop and ask for an explicit decision before:

- architectural or API trade-offs
- destructive or costly-to-reverse changes
- ambiguous requirements
- preference-dependent implementation choices

That matches the repo's current pi setup, where `ask-user` is available as a recommended decision-gating skill.

`pi-codex-image-gen` is a separate optional suggested npm/pi extension for image-generation tasks. It is not shipped, bundled, or required by `@chankov/agent-fleet`; choose it during guided setup's External pi packages group (when package installation is available), or install it manually:

```bash
pi install -l npm:pi-codex-image-gen
```

Credit: <https://github.com/jvm/pi-mono>.

---

## How It Works

### 1. Skill Discovery

pi searches these locations for skills (all are merged):

```
.agents/skills/           ← this install (walked upward from cwd)
.pi/skills/               ← project scope
~/.agents/skills/         ← global convention
~/.pi/agent/skills/       ← pi global config
<pi packages>             ← bundled/installed pi packages (e.g. `pi-ask-user`, optional `pi-codex-image-gen`)
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

The repo's `AGENTS.md` encodes the intent-to-skill mapping and workflow rules that drive skill selection.

### 3. Prompt Templates

pi also searches for prompt templates in:

```
.pi/prompts/*.md          ← this command install (walked upward from cwd)
~/.pi/agent/prompts/*.md  ← pi global command config
<pi packages>             ← bundled/installed pi packages
```

Each Markdown file becomes a slash command by filename. For example:

```
.pi/prompts/af-spec.md          → /af-spec
.pi/prompts/af-code-simplify.md → /af-code-simplify
```

These lifecycle commands are not replacements for skills. They are workflow entry points that add orchestration and tell the agent which skills to load and follow for the current phase.

### 4. Invocation

Three ways to trigger the workflow:

- **Explicit skill:** type `/skill:<name>` (e.g. `/skill:spec-driven-development`)
- **Lifecycle command:** type `/af-spec`, `/af-plan`, `/af-build`, `/af-test`, `/af-review`, `/af-code-simplify`, or `/af-ship`
- **Automatic:** describe intent in natural language — the model reads `AGENTS.md` and loads the matching skill

### 5. Lifecycle Mapping

The development lifecycle is encoded in both `AGENTS.md` and the pi prompt templates:

- DEFINE → `/af-spec` → `spec-driven-development`
- PLAN → `/af-plan` → `planning-and-task-breakdown`
- BUILD → `/af-build` → `incremental-implementation` + `test-driven-development`
- VERIFY → `/af-test` → `test-driven-development`; use `debugging-and-error-recovery` when tests or builds fail
- REVIEW → `/af-review` → `code-review-and-quality`
- SIMPLIFY → `/af-code-simplify` → `code-simplification`
- SHIP → `/af-ship` → `shipping-and-launch`

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
/af-spec Add authentication to this app
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
/af-test This endpoint is returning 500 errors
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
/af-review
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
3. Type `/` and confirm the lifecycle commands autocomplete: `/af-spec`, `/af-plan`, `/af-build`, `/af-test`, `/af-review`, `/af-code-simplify`, and `/af-ship`.
4. Run `/af-spec design a new feature for X` — confirm pi expands the command and invokes `spec-driven-development`.
5. Ask: *"fix this bug"* — confirm pi invokes `debugging-and-error-recovery`, or run `/af-test` to start a TDD/debugging workflow explicitly.
6. Give pi an ambiguous or high-stakes request and confirm it can use the `ask_user` tool / `ask-user` skill to request an explicit decision.

Start any diagnosis with the installer's own read-only report — it compares what
is recorded, what is on disk, and what the package ships, and exits `2` when
something is broken:

```bash
npx @chankov/agent-fleet verify --agent pi
npx @chankov/agent-fleet doctor --fix     # repair missing/dangling items
```

If skill autocomplete is empty, check that `.pi/skills/` contains `<skill-name>/SKILL.md` directories and that pi was not started with `--no-skills`.

If lifecycle command autocomplete is empty, check that `.pi/prompts/` contains the command Markdown files and run `/reload` or restart pi.

If `/af-chrome_devtools-status` reports `Cannot find module '@modelcontextprotocol/sdk/client/index.js'`, the MCP extension loaded but its runtime initialization failed. An `[Extensions]` startup entry alone does not prove its tools registered.

The fix is the dependency install that `--allow-exec` would have run:

```bash
npm ci --prefix .pi/extensions
```

Verify the repair with `/af-chrome_devtools-status`; it must report `connected` and a non-zero registered tool count. An `[Extensions]` startup entry alone does not prove the tools registered.

The harnesses install separately — if a harness reports `Cannot find module 'yaml'` or `'@sinclair/typebox'`, run `npm ci --prefix .pi/harnesses` as well (or `just install` from a clone, which does both).

Then run `/reload` or restart pi.

---

## Limitations

- Automatic skill loading depends on the underlying model's compliance with `AGENTS.md` rules.
- Prompt-template commands expand into instructions; they do not mechanically execute `/skill:<name>`. The pi-specific prompt templates therefore explicitly tell the agent which skills to load and follow.
- The CLI installs per workspace only; a machine-wide install means the pi package (`pi install npm:@chankov/agent-fleet`), which carries skills and prompts but not the extensions or harnesses.
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

- `/af-spec`
- `/af-plan`
- `/af-build`
- `/af-test`
- `/af-review`
- `/af-code-simplify`
- `/af-ship`

Or invoke individual skills directly when you want precise control:

- `/skill:spec-driven-development`
- `/skill:planning-and-task-breakdown`
- `/skill:incremental-implementation`
- `/skill:debugging-and-error-recovery`
- `/skill:code-review-and-quality`

---

## Summary

pi integration works by leveraging pi's **native** Agent Fleet and prompt-template support:

- `npx @chankov/agent-fleet install --agent pi --profile recommended --yes` writes the skills to `.pi/skills/` and the lifecycle commands to `.pi/prompts/`
- add `--profile pi-fleet-core --allow-exec` for the harness stack, its `justfile` region, and its runtime dependencies
- install `@chankov/agent-fleet` as a pi package for bundled `ask_user`, or install `pi-ask-user` separately for clone setup
- let pi auto-load `AGENTS.md` from the repo root
- use `/skill:<name>`, lifecycle commands like `/af-spec`, or natural language to trigger workflows
- keep it current with `agent-fleet upgrade`, check it with `agent-fleet verify`, repair it with `agent-fleet doctor --fix`

Guided setup can additionally offer the optional `pi-codex-image-gen` package when pi package installation is available, but it is not part of the minimal path.

The result is a fully agent-driven, production-grade engineering workflow — from one CLI command, with no coding agent and no model needed to install it.
