# pi Extensions

A catalog of the pi extensions in this repo — what each one does, how to run it, the
supporting data it needs, and how the ported set differs from upstream.

---

## Attribution

The session harnesses documented here — together with their supporting agent
definitions, design specs, the `coms-net` hub server, and the `justfile` — are ported
from the **`pi-vs-claude-code`** project:

- **Author:** [disler](https://github.com/disler) (IndyDevDan)
- **Source:** <https://github.com/disler/pi-vs-claude-code>
- **License:** MIT — Copyright (c) 2026 IndyDevDan

Ported files retain their original authorship; this repo adapts them to its layout and
conventions. Runtime design specs for the imported harnesses live in `docs/pi-specs/`.

---

## What these extensions are

`.pi/extensions/` ships always-on **utility** extensions — `mcp-bridge`,
`chrome-devtools-mcp`, `compact-and-continue`, `agent-skills-update-check`, and `btw`. pi
auto-discovers that directory, so they layer onto every session. `btw` adds a
`/btw <task>` prompt command (plus an `Alt+Shift+B` shortcut) that forks the current session
into an in-process sub-session and opens a live modal over it — full context, same
cwd, follow-up composer, with a compact result card landing in the main transcript at
idle. See [.pi/extensions/btw/README.md](../.pi/extensions/btw/README.md).

The documented harnesses below are different: each is a **session harness**. They
reshape the whole pi session — some remove every codebase tool and leave only an
orchestration tool, some set UI surfaces, some gate every tool call. Most are loaded
one per session; the supported stack is `damage-control` before `agent-hub`, which the
`just hub` recipes use by default. They live in **`.pi/harnesses/`** — a directory pi
does *not* auto-discover — so a plain `pi` run never loads them.

### Selective loading — read this first

pi auto-discovers every extension directory under a project's `.pi/extensions/` and loads
all of them. If the harnesses lived there, a plain `pi` run would load them all at once
— UI surfaces would fight, orchestrators would collide, and `coms` / `coms-net` would
abort startup with duplicate CLI-flag registrations. So the harnesses live in
`.pi/harnesses/` instead, and you load the desired recipe explicitly:

- through the `justfile` — `just hub`, `just ext-damage-control`, `just local-coms`, …
- or directly — `pi -e .pi/harnesses/<name>/index.ts`

When you consume this repo from another project, point `pi -e` at the harness file you
want, or symlink that one directory into *its* `.pi/harnesses/` — never drop the harnesses
into `.pi/extensions/`, and never load all of them at once. The supported multi-harness
exception is loading `damage-control` before `agent-hub` for a guarded hub session (see
[pi-setup.md](pi-setup.md#optional-pi-extensions)).

---

## Setup

```bash
just install            # one-time — installs runtime deps for extensions + harnesses
just hub                # launch the supported multi-agent hub with damage-control guardrails
just --list             # see every recipe
```

`just install` runs `npm install` for both dependency roots: `.pi/extensions/` for the
utilities (`@modelcontextprotocol/sdk`, `typebox`) and `.pi/harnesses/` for the harnesses
(`@sinclair/typebox`, `yaml`). The `@mariozechner/pi-*` packages are provided by the pi
runtime itself.

---

## Catalog

| Extension | Category | What it does | Run |
|-----------|----------|--------------|-----|
| [agent-hub](../.pi/harnesses/agent-hub/README.md) | Orchestration | Supported multi-agent hub: damage-control guardrails by default via `just hub`, dispatcher grid, specialist delegation, research helpers, persona gate, embedded coms, `/handoff`, and peer-as-subagent | `just hub` |
| [damage-control](../.pi/harnesses/damage-control/README.md) | Safety | Blocks destructive tool calls and aborts the turn; also loaded before `agent-hub` by the hub recipes | `just ext-damage-control` |
| [coms](../.pi/harnesses/coms/README.md) | Messaging | Peer-to-peer messaging between pi agents on one machine | `just local-coms` |
| [coms-net](../.pi/harnesses/coms-net/README.md) | Messaging | HTTP/SSE communication network across hosts (needs the hub) | `just coms` |

Each extension directory has its own `README.md` with the full description, command/tool
surface, requirements, and per-extension upstream changes.

### `agent-hub` components

`agent-hub` is the consolidated orchestration harness. It replaces the retired standalone
`agent-team` recipe and absorbs the day-to-day pieces that previously required separate
harnesses:

- **Dispatcher grid** — fixed specialists from `.pi/agents/teams.yaml`, shown in a live dashboard
  with compact/full view toggling.
- **Specialist delegation** — `dispatch_agent` for writable child-agent work and
  `spawn_research` / `/research` for read-only investigation.
- **Verification Contract** — the dispatcher owns a ledger of checkable acceptance assertions
  built before any builder runs, via the `set_assertions` / `update_assertion` tools. Each
  assertion is tagged (`test` | `runtime-ui` | `code-grep` | `manual`) and advanced only on
  *proven with evidence*; the ledger persists to `.pi/agent-sessions/assertions.json` (wiped at
  session start like `findings/`) and shows a one-line status, keeping the contract out of the
  dispatcher LLM context. It kills the parity failure (exemplar shipped, siblings missed) by
  requiring a parity/touchpoint inventory for "behave like" requests and runtime proof for UI
  assertions — see the [`orchestration-verification`](../skills/orchestration-verification/SKILL.md)
  skill, which the `orchestrator` persona drives. Advisory in this phase (surfaced, not a hard
  dispatch refusal).
- **Persona gate** — requires an orchestrator persona at startup unless disabled in the local
  override file; the chosen persona also feeds the coms purpose when no explicit `--purpose` is set.
- **Operator controls** — `/zoom` timeline inspection plus child-agent kill/restart controls.
- **Damage-control by default** — `just hub` / `just hub-solo` load the hard-stop safety harness
  before `agent-hub`, so dispatcher tool calls are checked against the rules file. `agent-hub` also
  re-loads that same harness into every spawned specialist and research helper (via an explicit `-e`
  that survives their `--no-extensions`), so subagent tool calls are guarded too.
- **Embedded coms** — peer discovery, `coms_list` / `coms_send` / `coms_get` / `coms_await`,
  `/handoff`, and peer-as-subagent flows.
- **Solo mode** — `just hub-solo` keeps the dispatcher grid, delegation, research helpers, persona
  gate, and controls, but starts without the embedded coms layer.

---

## Two browser stacks — when to use which

This repo ships **two** ways to drive a browser from a pi agent. They are complementary, not redundant — the axis that separates them is the **tool model** (and where they can run), not just headless-vs-headful, since both can do either:

| | `bowser` / `playwright-cli` | `web-debugger` / `chrome-devtools-mcp` |
|---|---|---|
| Tool model | CLI over **Bash** (no tool schemas in context) | live `chrome_devtools__*` MCP tools |
| Strength | headless, parallel named sessions, background automation, scraping, token-efficient | interactive headful debugging, live DOM/console/network, performance traces |
| Where it runs | **dispatched subagent** (survives `--no-extensions`), peer, or main session | main session or **coms peer** (the extension must be loaded into the process) |
| Persona | `bowser` | `web-debugger` |
| Skill | `.pi/skills/bowser/` | `skills/browser-testing-with-devtools/` |

**Policy:**

- **Automated / CI / background / parallel runtime-UI evidence** → `bowser` (headless `playwright-cli`). This is what the `orchestrator` delegates as a subagent to close `runtime-ui` acceptance assertions.
- **Interactive debugging of a running dev app** → `web-debugger` (headful `chrome-devtools-mcp`), reached as a coms peer or run on the main session.
- **Manual visual inspection / login flows** → `web-debugger` headful, or attach to an existing Chrome.
- **Always require runtime evidence** — snapshot + console + network before/after a critical interaction; a screenshot only for visual/layout confirmation.

Why `web-debugger` is a coms peer and not a dispatchable subagent: its `chrome_devtools__*` tools come from the always-on `chrome-devtools-mcp` extension, and agent-hub spawns subagents with `--no-extensions`, so a dispatched child would not have those tools. A coms peer is its own pi process that loads the extension explicitly (via the `extensions:` field in `.pi/agents/peers.yaml`, routed through the `_peer-plus` recipe), and a long-lived peer maps naturally onto one persistent live browser. `bowser` has no such constraint because it only needs Bash + the `playwright-cli` binary on PATH.

## Environment variables

The `justfile` sets `dotenv-load`, so a `.env` file at the repo root is auto-loaded
(`.env` is gitignored). Only a few extensions need keys:

| Variable | Needed by | Purpose |
|----------|-----------|---------|
| `PI_COMS_NET_AUTH_TOKEN` | `coms-net` | Shared secret — required to bind a LAN/remote hub |
| `PI_COMS_NET_PORT` | `coms-net` | Pin the hub port so the URL is stable across restarts |
| `PI_COMS_NET_SERVER_URL` | `coms-net` | Hub URL for clients (blank = auto-discover the local `server.json`) |

For `127.0.0.1`-only `coms-net` use, the hub auto-generates a token — no env needed.

---

## Supporting data

These ported files are runtime dependencies of the extensions above:

- **`agents/`** — canonical persona Markdown files for shared and pi-specific agents.
  Read by `agent-hub`.
- **`.pi/agents/`** — pi YAML configs only (`teams.yaml`, `peers.yaml`).
  The earlier `reviewer` and `red-team` personas were folded into `code-reviewer` and
  `security-auditor`; the remaining team/peer configs already reference the canonical names.
  A peer entry may carry an optional `extensions:` field (comma-separated names under
  `.pi/extensions/`) — `team-up` then routes it through the `_peer-plus` recipe so those
  extensions load into the peer process. The `web-debugger` peer uses this to get
  `chrome-devtools-mcp`'s `chrome_devtools__*` tools (see the two-browser-stacks section above).
- **`.pi/damage-control-rules.yaml`** — the destructive-command / protected-path rule set
  for `damage-control`.
- **`.pi/skills/bowser/`** — a pi-runtime skill for headless Playwright browser
  automation, used by the `bowser` agent persona. Kept separate from the core
  engineering `skills/`. It drives the external **Playwright Agent CLI**
  (`playwright-cli`), which is **not** bundled — install it once with
  `npm install -g @playwright/cli@latest` (the guided setup checks for it when
  `bowser` is selected). Docs: <https://playwright.dev/agent-cli/installation>.
- **`scripts/coms-net-server.ts`** — the HTTP/SSE hub server for `coms-net`. Pure Node
  built-ins; run it with `node --experimental-strip-types scripts/coms-net-server.ts`
  (Node >= 22.6, or `just coms-net-server`).
- **`docs/pi-specs/`** — the original design specifications: `agent-forge` (now consolidated
  into `agent-hub`), `agent-workflow` (retired `agent-chain`), and `damage-control`.

---

## Upstream changes

What changed relative to `disler/pi-vs-claude-code`:

- **Theme code removed.** Every ported harness imported `applyExtensionDefaults` from a
  shared `themeMap.ts`. That import and its `session_start` call site were stripped from
  the ported files; `themeMap.ts` and the 11 `.pi/themes/*.json` palettes are not ported.
  Extensions render against pi's active theme.
- **Layout converted.** Flat `extensions/<name>.ts` files became
  `.pi/harnesses/<name>/index.ts` directories, each with its own `package.json` and
  `README.md`. They live under `.pi/harnesses/` — *not* `.pi/extensions/` — because pi
  auto-discovers and loads everything in `.pi/extensions/`, while harnesses must be loaded
  explicitly through recipes (with `damage-control` before `agent-hub` as the supported stack).
- **Tooling switched to npm.** `bun` / `bun.lock` are not used; the `justfile` recipes
  point at the new paths and use npm. The `coms-net` hub launches via
  `node --experimental-strip-types` instead of `bun`.

### Not ported

- The `pure-focus`, `theme-cycler`, and `cross-agent` extensions.
- `themeMap.ts` and all 11 `.pi/themes/*.json` theme palettes.
- The Claude Code `statusLine` config and `status_lines/status_line.py`, and the
  `plan_w_team.md` command (it depended on team-agent files absent from the source).

### A note on `.pi/settings.json`

Upstream shipped a `.pi/settings.json` that only set the (now-stripped) theme and
registered a prompt directory. This repo already keeps pi prompts in the standard
`.pi/prompts/` location, so no `.pi/settings.json` is shipped — it would carry nothing
useful.
