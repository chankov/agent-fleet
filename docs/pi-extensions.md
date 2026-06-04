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

`.pi/extensions/` ships three always-on **utility** extensions — `mcp-bridge`,
`chrome-devtools-mcp`, and `compact-and-continue`. pi auto-discovers that directory, so
those three layer onto every session.

The documented harnesses below are different: each is a **session harness**. They
reshape the whole pi session — some remove every codebase tool and leave only an
orchestration tool, some set UI surfaces, some gate every tool call. They are
**mutually exclusive by design**: run one per session, not all at once. Because of that
they live in **`.pi/harnesses/`** — a directory pi does *not* auto-discover — so a
plain `pi` run never loads them.

### Selective loading — read this first

pi auto-discovers every extension directory under a project's `.pi/extensions/` and loads
all of them. If the harnesses lived there, a plain `pi` run would load them all at once
— UI surfaces would fight, orchestrators would collide, and `coms` / `coms-net` would
abort startup with duplicate CLI-flag registrations. So the harnesses live in
`.pi/harnesses/` instead, and you load exactly one explicitly:

- through the `justfile` — `just ext-agent-team`, `just ext-purpose-gate`, …
- or directly — `pi -e .pi/harnesses/<name>/index.ts`

When you consume this repo from another project, point `pi -e` at the harness file you
want, or symlink that one directory into *its* `.pi/harnesses/` — never drop the harnesses
into `.pi/extensions/`, and never load all of them at once (see
[pi-setup.md](pi-setup.md#optional-pi-extensions)).

---

## Setup

```bash
just install            # one-time — installs runtime deps for extensions + harnesses
just ext-agent-team     # launch pi with a harness
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
| [session-replay](../.pi/harnesses/session-replay/README.md) | UI | `/replay` scrollable timeline overlay of session history | `just ext-session-replay` |
| [purpose-gate](../.pi/harnesses/purpose-gate/README.md) | Focus | Forces you to declare session intent before working | `just ext-purpose-gate` |
| [damage-control](../.pi/harnesses/damage-control/README.md) | Safety | Blocks destructive tool calls and aborts the turn | `just ext-damage-control` |
| [damage-control-continue](../.pi/harnesses/damage-control-continue/README.md) | Safety | Same rules, but the agent keeps working with corrective feedback | `just ext-damage-control-continue` |
| [subagent-widget](../.pi/harnesses/subagent-widget/README.md) | Orchestration | `/sub <task>` background subagents with live stacking widgets | `just ext-subagent-widget` |
| [agent-team](../.pi/harnesses/agent-team/README.md) | Orchestration | Dispatcher-only orchestrator with a grid dashboard | `just ext-agent-team` |
| [agent-hub](../.pi/harnesses/agent-hub/README.md) | Orchestration | agent-team dispatcher + embedded coms (peer `/handoff` & peer-as-subagent) | `just hub` |
| [agent-chain](../.pi/harnesses/agent-chain/README.md) | Orchestration | Sequential agent pipeline orchestrator | `just ext-agent-chain` |
| [system-select](../.pi/harnesses/system-select/README.md) | Orchestration | `/system` to pick an agent persona as the system prompt | `just ext-system-select` |
| [pi-pi](../.pi/harnesses/pi-pi/README.md) | Orchestration | Meta-agent that builds pi agents via parallel expert research | `just ext-pi-pi` |
| [coms](../.pi/harnesses/coms/README.md) | Messaging | Peer-to-peer messaging between pi agents on one machine | `just local-coms` |
| [coms-net](../.pi/harnesses/coms-net/README.md) | Messaging | HTTP/SSE communication network across hosts (needs the hub) | `just coms` |

Each extension directory has its own `README.md` with the full description, command/tool
surface, requirements, and per-extension upstream changes.

---

## Environment variables

The `justfile` sets `dotenv-load`, so a `.env` file at the repo root is auto-loaded
(`.env` is gitignored). Only a few extensions need keys:

| Variable | Needed by | Purpose |
|----------|-----------|---------|
| `FIRECRAWL_API_KEY` | `pi-pi` | Expert agents crawl current pi documentation via Firecrawl |
| `PI_COMS_NET_AUTH_TOKEN` | `coms-net` | Shared secret — required to bind a LAN/remote hub |
| `PI_COMS_NET_PORT` | `coms-net` | Pin the hub port so the URL is stable across restarts |
| `PI_COMS_NET_SERVER_URL` | `coms-net` | Hub URL for clients (blank = auto-discover the local `server.json`) |

For `127.0.0.1`-only `coms-net` use, the hub auto-generates a token — no env needed.

---

## Supporting data

These ported files are runtime dependencies of the extensions above:

- **`agents/`** — canonical persona Markdown files for shared and pi-specific agents,
  including the `agents/pi-pi/` research experts. Read by `agent-team`, `agent-chain`,
  `system-select`, and `pi-pi`.
- **`.pi/agents/`** — pi YAML configs only (`teams.yaml`, `agent-chain.yaml`, `peers.yaml`).
  The earlier `reviewer` and `red-team` personas were folded into `code-reviewer` and
  `security-auditor`; the team and chain configs already reference the canonical names.
- **`.pi/damage-control-rules.yaml`** — the destructive-command / protected-path rule set
  for `damage-control` and `damage-control-continue`.
- **`.pi/skills/bowser/`** — a pi-runtime skill for headless Playwright browser
  automation, used by the `bowser` agent persona. Kept separate from the core
  engineering `skills/`.
- **`scripts/coms-net-server.ts`** — the HTTP/SSE hub server for `coms-net`. Pure Node
  built-ins; run it with `node --experimental-strip-types scripts/coms-net-server.ts`
  (Node >= 22.6, or `just coms-net-server`).
- **`docs/pi-specs/`** — the original design specifications: `agent-forge` (the
  `agent-team` design), `agent-workflow` (`agent-chain`), `damage-control`, and `pi-pi`.

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
  auto-discovers and loads everything in `.pi/extensions/`, and these are
  mutually-exclusive harnesses that must be loaded one at a time.
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
