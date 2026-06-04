# agent-hub

A multi-agent dispatcher with [`coms`](../coms/README.md) **embedded** — so the dispatcher is
*also* a peer-to-peer node. It combines local specialist orchestration (fixed specialist grid,
read-only research helpers, `/zoom`, kill/restart, per-agent model, dispatcher persona gate) with
peer-to-peer collaboration: it can **hand a session off to another main agent** and **use a coms peer
as a subagent**.

> Consolidates the retired `agent-team` dispatcher into this harness and embeds the ported `coms`
> P2P layer from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by
> [disler](https://github.com/disler) (MIT). See the
> [extension catalog](../../../docs/pi-extensions.md) and the
> [design plan](../../../docs/plans/agent-hub-multi-agent-harness.md).

## What it does

`agent-hub` is the supported home for the former standalone dispatcher features:

- **Dispatcher grid** — a live dashboard of fixed specialists from `.pi/agents/teams.yaml`.
- **Specialist delegation** — `dispatch_agent` sends writable tasks to configured specialists.
- **Research helpers** — `spawn_research` and `/research` launch read-only helper agents for quick
  investigation.
- **Human handoff path** — `ask_user` is exposed when `pi-ask-user` is available, so specialists can
  bubble decisions back through the dispatcher.
- **Agent controls** — `/zoom` inspects a live agent timeline; kill/restart controls manage running
  child agents; per-agent `model:` fields select models from team config.
- **Dispatcher persona gate** — an orchestrator persona must be selected at session start unless the
  local override disables it.
- **Embedded coms** — the dispatcher is a discoverable peer on the local machine. Multiple
  `agent-hub` (or plain `coms`) sessions on the same box find each other through per-project registry
  files and exchange messages over a unix socket (named pipe on Windows).

Inherited `/zoom` behavior in this harness expands the latest event by default. Use `Space` or
`Ctrl+C` to copy the selected row content, and `Esc` to close the overlay.

Press **`Alt+A`** to toggle the agent view between the full **dashboard** (bordered card grid drawn
*above* the input box) and a **compact** view that shows one line per *running* agent —
`name · context% · state` — rendered *below* the input box, just above pi's status bar. Idle and
done agents are hidden in compact mode, and the coms pool widget collapses too, so an idle session
collapses to just the prompt and footer. The current mode and binding are shown in the footer
(`Alt+A view:dashboard` / `Alt+A view:compact`).

## The coms layer

### Identity

Each session registers a coms identity at start-up, resolved in this precedence order:

1. **CLI flags** — `--name`, `--purpose`, `--project`, `--color`, `--explicit`
2. **Dispatcher persona frontmatter** — `name`, `description` (→ purpose), `color` from the
   selected `kind: orchestrator` persona (see [persona sync](#persona--coms-purpose-sync))
3. **Defaults** — auto-generated name `hub-<id>`, purpose `agent-hub dispatcher`, project
   `default`, a deterministic color derived from the session id

Names are de-duplicated per project (`resolveUniqueName`), so two hubs that both want `architect`
become `architect` and `architect-2`. `--explicit` marks a **private** peer — addressable only by
its exact name, never surfaced as a broadcast target. The registry lives under
`~/.pi/coms/projects/<project>/agents/<name>.json` and is created at runtime.

### Commands & tools (added on top of agent-team's)

- `/coms` — coms control surface (peer list / status)
- `/handoff <peer>` — hand the whole session off to a coms peer (see [Handoff](#handoff))
- `coms_list` — discover peers: names, models, live context usage, purpose. Pass project `"*"`
  to list across all projects.
- `coms_send` — send a prompt to a peer; returns a `msg_id`
- `coms_await` — **block** until that `msg_id`'s reply lands (default 30 min,
  `PI_COMS_TIMEOUT_MS`)
- `coms_get` — **non-blocking** poll of a `msg_id` (status `pending|complete|error`)

`/coms` and `/handoff` tab-complete live peer names.

### Peer as subagent

The dispatcher uses a peer as a subagent by pairing the tools: `coms_send(target, prompt)` to
issue the task, then `coms_await(msg_id)` to block for the reply (or `coms_get` to poll). This sits
alongside `dispatch_agent` — local persona specialists are dispatched as subprocesses; remote peers
are reached over coms. v1 keeps the two paths explicit (a unified `delegate()` that auto-routes is a
later nicety). Multi-hop is inherited from coms: a peer handling a dispatched task can `coms_send`
onward, hops accumulating up to `MAX_HOPS` (5).

### Handoff

`/handoff <peer>` transfers the session to another **main** agent. Following the plan's
**decision G1**, it does *not* try to extract a compaction summary; instead it asks the dispatcher
LLM to compose a **self-contained brief** ("everything the target needs, assume no shared history"),
then `coms_send`s that brief to the peer, `coms_await`s the reply, and relays it back — in the
configured user-facing language. The target peer takes over; the source relays the result. There is
no raw session copy (pi sessions aren't portable between live agents).

### Pool widget

A live "pool" widget lists connected peers with name, model, and live context usage, refreshed by a
ping cycle; a keepalive cycle re-writes this session's own registry entry (and self-heals it if an
external prune removed it). Both timers are `unref`'d so they never hold the process open.

### Persona → coms purpose sync

The dispatcher persona gate fires *after* coms init, so the identity's `purpose` starts from the
flag/frontmatter/default and is then reconciled to the chosen persona: `syncComsPurpose()` maps the
selected `kind: orchestrator` persona to `"<Name> — <description>"` and re-writes the live registry
entry — **unless** `--purpose` was passed explicitly (an explicit flag always wins). Switching or
resetting the persona via `/persona` re-syncs.

### Graceful degradation

If the coms socket can't bind at start-up (`comsReady` stays `false`), the session degrades to a
plain agent-team dispatcher: the `coms_*` tools are withheld from `setActiveTools`, the
`/handoff` command refuses with a notice, and the "Peer agents (coms)" prompt section is omitted.
Orchestration, research helpers, and the grid keep working.

### Tool surface

`setActiveTools` always preserves the orchestration surface and adds coms when ready:

```ts
const dispatcherTools = ["dispatch_agent", "spawn_research"];
if (comsReady)        dispatcherTools.push("coms_list", "coms_send", "coms_get", "coms_await");
if (askUserAvailable) dispatcherTools.push("ask_user");
```

The dispatcher persona is **flavor-only** (decision G4 / 9) — it enriches the role but never narrows
this tool set, so coms and dispatch stay available regardless of the chosen persona.

## Requires

- `.pi/agents/teams.yaml` for fixed specialist teams, the referenced persona `.md` files, and
  (strongly recommended) [`pi-ask-user`](https://github.com/edlsh/pi-ask-user).
- Nothing extra in-repo for coms — the peer registry lives at `~/.pi/coms/` and is created at
  runtime. For an HTTP/SSE transport that works across hosts, use
  [`coms-net`](../coms-net/README.md) instead.

## Usage

```bash
# via the justfile (accepts coms identity flags)
just hub
just hub --name architect --purpose "owns the migration design" --project myrepo

# or directly
pi -e .pi/harnesses/agent-hub/index.ts
pi -e .pi/harnesses/agent-hub/index.ts --name releaser --explicit
```

Identity flags: `--name`, `--purpose`, `--project`, `--color`, `--explicit`.

### Related recipes

```bash
# the hub without the coms layer (fixed specialists + research only — lighter)
just hub-solo

# a single reusable coms peer — POSITIONAL args: persona [name] [model]
# persona is a file under agents/ (no .md; legacy .pi/agents/ fallback); it loads coms + compact-and-continue
just peer architect architect anthropic/claude-opus-4-7

# spawn every peer of a team from .pi/agents/peers.yaml into tiled tmux panes
just team-up full        # launch
just team-up-dry full    # print the resolved `just peer …` commands without launching
```

`peers.yaml` groups reusable peers into named teams; each entry is `name` / `persona`
(+ optional `model`). The persona's frontmatter `description`/`color` become the peer's
coms purpose/color.

## How it differs from its sources

- **Embedded, not stacked (decision 1).** coms is folded into this one `index.ts`; the identity
  flags are registered once. Loading `coms` as a second `-e` would double-register
  `--name/--purpose/...` and abort start-up.
- **Single `session_start`.** coms init is folded into agent-team's existing `session_start` and
  guarded by `if (!comsReady)`, so `/new` reuses the same peer identity (no leaked socket).
- **Dispatcher is also a peer.** `setActiveTools` lists `coms_*` alongside `dispatch_agent` +
  `spawn_research` (+ `ask_user`); the system prompt gains a "Peer agents (coms)" section when coms
  is ready. The persona's `description` drives the coms `purpose` (decision 6 / Phase 6 peer
  mapping) instead of a static `--purpose`.
- **`/handoff` uses an LLM-composed brief**, not a compaction-summary extraction (decision G1).
- **Clean shutdown** SIGTERMs any running specialist/research children, clears the coms pool
  widget, and removes the registry entry on `session_shutdown` / SIGINT / SIGTERM.
