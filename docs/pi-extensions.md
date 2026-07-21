# pi Extensions

A catalog of the pi extensions in this repo — what each one does, how to run it, the
supporting data it needs, and how the ported set differs from upstream.

---

## Attribution

The session harnesses documented here — together with their supporting agent
definitions, design specs, and the `justfile` — are ported
from the **`pi-vs-claude-code`** project:

- **Author:** [disler](https://github.com/disler) (IndyDevDan)
- **Source:** <https://github.com/disler/pi-vs-claude-code>
- **License:** MIT — Copyright (c) 2026 IndyDevDan

Ported files retain their original authorship; this repo adapts them to its layout and
conventions. Runtime design specs for the imported harnesses live in `docs/pi-specs/`.

---

## What these extensions are

`.pi/extensions/` ships always-on **utility** extensions — `mcp-bridge`,
`chrome-devtools-mcp`, `compact-and-continue`, `agent-fleet-update-check`, `btw`, and
`pi-voice-stt`. pi
auto-discovers that directory, so they layer onto every session. `btw` adds a
`/btw <task>` prompt command (plus an `Alt+'` shortcut) that forks the current session
into an in-process sub-session and opens a live modal over it — full context, same
cwd, follow-up composer, with a compact result card landing in the main transcript at
idle. See [.pi/extensions/btw/README.md](../.pi/extensions/btw/README.md).

`pi-voice-stt` adds **Alt+S** push-to-talk dictation: it records the mic to a temp WAV via
`ffmpeg` and transcribes through one of three backends — a generic OpenAI-compatible endpoint,
Azure Speech (REST short-audio, with optional per-phrase language identification), or Azure
OpenAI Whisper (Azure AI Foundry). Alt+S toggles record→insert; Enter-while-recording
transcribes and sends; Esc cancels. It is **gated**: the hotkey binds only once a provider is
configured (project-local `.ai/stt.json`, the global `~/.pi/agent/stt.json`, or `PI_STT_CONFIG`),
so an unconfigured session is a no-op. `/stt doctor`
checks the setup. A simplified port of [`cgarrot/pi-voice-stt`](https://github.com/cgarrot/pi-voice-stt);
see [.pi/extensions/pi-voice-stt/README.md](../.pi/extensions/pi-voice-stt/README.md).

The documented harnesses below are different: each is a **session harness**. They
reshape the whole pi session — some remove every codebase tool and leave only an
orchestration tool, some set UI surfaces, some gate every tool call. Most are loaded
one per session; the supported stack is `damage-control-continue` + `ask-user-remote`
before `agent-hub`, which the `just hub` recipes use by default. They live in
**`.pi/harnesses/`** — a directory pi does *not* auto-discover — so a plain `pi`
run never loads them.

### Selective loading — read this first

pi auto-discovers every extension directory under a project's `.pi/extensions/` and loads
all of them. If the harnesses lived there, a plain `pi` run would load them all at once
— UI surfaces would fight, orchestrators would collide, and harnesses that register the
same CLI flags would abort startup with duplicate registrations. So the harnesses live in
`.pi/harnesses/` instead, and you load the desired recipe explicitly:

- through the `justfile` — `just hub`, `just ext-damage-control-continue`, `just safe-coms`, …
- or directly — `pi -e .pi/harnesses/<name>/index.ts`

When you consume this repo from another project, point `pi -e` at the harness file you
want, or symlink that one directory into *its* `.pi/harnesses/` — never drop the harnesses
into `.pi/extensions/`, and never load all of them at once. The supported multi-harness
exception is loading `damage-control-continue` and `ask-user-remote` before `agent-hub` for a guarded hub session (see
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
| [agent-hub](../.pi/harnesses/agent-hub/README.md) | Orchestration | Supported multi-agent hub: damage-control guardrails by default via `just hub`, dispatcher grid, specialist delegation, research helpers, persona gate, embedded coms, `/handoff`, peer-as-subagent, and footer `v<version> · <model><thinking> · <team>` — plus, inside a [herdr](https://herdr.dev) pane, fleet tools (`herdr_spawn_peer` / `herdr_read_pane` / `herdr_close_pane` with human confirmation / `herdr_notify`) | `just hub` |
| [ask-user-remote](../.pi/harnesses/ask-user-remote/README.md) | Orchestration | Captures stock `pi-ask-user` and registers the default `ask_user`; with `user-remote` live it races local UI against the Hermes bridge, otherwise it is stock local behavior | loaded by `just hub` / `hub-solo` |
| [damage-control-continue](../.pi/harnesses/damage-control-continue/README.md) | Safety | Only supported safety harness; guards the hub plus every native specialist, researcher, and delegate. Blocks feed back without aborting the turn; protected paths support explicit approval, while dangerous command patterns remain non-exemptible | `just ext-damage-control-continue` |
| [coms](../.pi/harnesses/coms/README.md) | Messaging | Peer-to-peer messaging between pi agents on one machine; launches damage-control-continue-guarded under a chosen name | `just safe-coms <name>` |
| [Hermes local monitor transport](../hermes/README.md#local-agent-hub-monitor-integration) | Optional local companion | Owner-only discovery + Unix socket for agent-hub snapshots, cursor output, and exact-generation cancellation; consumed by a separate local Hermes client | Set the two monitor environment variables, then run `just hub-team <team>` |

Each extension directory has its own `README.md` with the full description, command/tool
surface, requirements, and per-extension upstream changes.

### Migration: retired hard-stop harness

The former `.pi/harnesses/damage-control/` hard-stop harness and `just ext-damage-control`
recipe are retired. Refresh pi harnesses with guided setup: it removes only an unchanged,
setup-recorded copy (or an agent-fleet source symlink), preserves user-modified/unowned copies,
and refreshes the managed `justfile` region. Use `damage-control-continue` for standalone and
Agent Hub safety; missing child safety now fails closed instead of falling back or spawning
unguarded.

### Harness version footer and provenance

The three persistent-UI harnesses — `agent-hub`, `coms`, and
`damage-control-continue` — each register `v<version>` on one shared status key. In pi's
default status footer, that shared key gives a supported stack exactly one version instead of one
copy per harness. `agent-hub` replaces the default footer: it does **not** consume that status
key. Its custom footer reads its own adjacent stamped manifest and renders one local version
first — `v<version> · <model><thinking> · <team>` — so an agent-hub stack also displays the
version exactly once.

The shared version status is independent of mutable owner status: for example, a
Damage-Control violation can replace its own safety message without overwriting the version
entry. The canonical value is the root `package.json` version. During a release,
`bin/sync-harness-versions.js` stamps that value into each adjacent persistent-harness
`package.json` after the root bump and before lockfile finalization and snapshotting. Each
harness keeps a local `version.ts` provenance reader so copied or symlinked harness directories
resolve their adjacent stamp rather than the launch directory. That local provenance does not
make a harness self-contained: copied target harnesses still require the existing full
`.pi/harnesses/` dependency installation described in [Setup](#setup).

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
- **Damage-control + ask_user by default** — `just hub` / `just hub-solo` load the
  `damage-control-continue` safety harness and `ask-user-remote` before `agent-hub`, so the
  dispatcher's tool calls are checked against the rules file and the `askUserAvailable` probe sees
  `ask_user`. A blocked call feeds back and the turn keeps going rather than aborting. `agent-hub` also
  re-loads `damage-control-continue` into every native specialist, research helper, and nested
  delegate (via an explicit `-e` that survives `--no-extensions`). Protected-path access can be
  granted at runtime: `/allow <pattern> [turn|session]` in the hub pre-authorizes, a parent-session
  block opens an approval dialog, and a headless child escalates to the hub. Protected deletion
  offers only deny/once; other protected paths may be scoped to an agent or session. Denial and
  timeout fail closed without aborting the child turn. Destructive bash patterns are never exemptible,
  and a missing continue harness refuses child dispatch.
- **Embedded coms** — peer discovery, `coms_list` / `coms_send` / `coms_get` / `coms_await`,
  `/handoff`, and peer-as-subagent flows.
- **Solo mode** — `just hub-solo` keeps the dispatcher grid, delegation, research helpers, persona
  gate, and controls, but starts without the embedded coms layer.
- **Optional Hermes local monitor transport** — uses `AGENT_FLEET_PROFILE_ID`, the absolute
  `AGENT_FLEET_MONITOR_RUNTIME_DIR`, and the Herdr `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID`
  required to establish its stable hub identity. It is a source-owned, local-only transport—not a
  Hermes SDK task/lifecycle RPC or a bundled plugin—and fails closed without validated owner-only
  discovery, lease, token, and socket state. Follow the
  [Hermes integration guide](../hermes/README.md#local-agent-hub-monitor-integration) for startup,
  wire examples, cancellation semantics, and reconnect behavior.

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
| `PI_CHROME_DEVTOOLS_MODE` | `chrome-devtools-mcp` | `headless` runs Chrome with no UI; anything else (default) is headed |
| `PI_CHROME_DEVTOOLS_BROWSER_URL` | `chrome-devtools-mcp` | Attach to a running Chrome (e.g. `http://127.0.0.1:9222`) instead of launching one |
| `PI_CHROME_DEVTOOLS_USER_DATA_DIR` | `chrome-devtools-mcp` | Persistent Chrome profile path (else the default ephemeral `--isolated` profile) |
| `OPENAI_API_KEY` | `pi-voice-stt` (openai backend) | API key for the OpenAI-compatible transcription endpoint (var name overridable via `provider.apiKeyEnv`) |
| `AZURE_SPEECH_KEY` | `pi-voice-stt` (azure backend) | Azure Speech resource key |
| `AZURE_SPEECH_ENDPOINT` | `pi-voice-stt` (azure backend) | Azure resource endpoint, used when `provider.endpoint` is unset |
| `PI_STT_CONFIG` / `PI_STT_KEYBIND` | `pi-voice-stt` | Override config (inline JSON or path) / the record hotkey (default `alt+s`) |
| `AGENT_FLEET_SPAWN_DELAY` | `_peer` / `_peer-plus` recipes | Seconds to sleep before launching pi in a fleet pane (set per pane by `team-up`/`team-resume`, see below) |

The `chrome-devtools-mcp` server starts once at extension load, so changing its vars needs a pi
restart / `/reload` to take effect.

### Spawn pre-warm/stagger

pi loads its credential store (`~/.pi/agent/auth.json`) once at boot under a short-retry
file lock. When the stored OAuth token is stale, the first pi to boot refreshes it over
the network *while holding that lock*; sibling panes spawned in the same instant (as
`just team-up` / `just hub-team` / `just team-resume` do) lose the lock race and come up
with every provider showing **unconfigured**. To dodge this, the team scripts check
`auth.json` before spawning (only `type`/`expires` are read — values never leave the
process): if any OAuth credential is expired or about to expire, one pi pane (the hub
when present, else the first pi peer) starts immediately and refreshes the token, and
every other pi pane gets `AGENT_FLEET_SPAWN_DELAY` in its pane env — the `_peer` /
`_peer-plus` recipes sleep that many seconds before launching pi. Fresh tokens mean zero
delay everywhere; `claude-code` runner panes never wait. Pure logic in
`scripts/lib/spawn-stagger.ts` (under `node --test`).

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
  for `damage-control-continue`.
- **`.pi/skills/bowser/`** — a pi-runtime skill for headless Playwright browser
  automation, used by the `bowser` agent persona. Kept separate from the core
  engineering `skills/`. It drives the external **Playwright Agent CLI**
  (`playwright-cli`), which is **not** bundled — install it once with
  `npm install -g @playwright/cli@latest` (the guided setup checks for it when
  `bowser` is selected). Docs: <https://playwright.dev/agent-cli/installation>.
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
  explicitly through recipes (with `damage-control-continue` + `ask-user-remote` before
  `agent-hub` as the supported stack).
- **Tooling switched to npm.** `bun` / `bun.lock` are not used; the `justfile` recipes
  point at the new paths and use npm.

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
