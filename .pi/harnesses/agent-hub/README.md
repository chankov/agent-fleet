# agent-hub

A multi-agent dispatcher with [`coms`](../coms/README.md) **embedded** — so the dispatcher is
*also* a peer-to-peer node. The bundled `just hub` recipes load
[`damage-control-continue`](../damage-control-continue/README.md) first, giving the dispatcher
guardrails that block but feed back (the turn keeps going) by default. It combines local specialist
orchestration (fixed specialist grid, read-only research helpers, `/zoom`, kill/restart, per-agent
model, dispatcher persona gate) with peer-to-peer collaboration: it can **hand a session off to
another main agent** and **use a coms peer as a subagent**.

> Consolidates the retired `agent-team` dispatcher into this harness and embeds the ported `coms`
> P2P layer from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by
> [disler](https://github.com/disler) (MIT). See the
> [extension catalog](../../../docs/pi-extensions.md) and the
> [design plan](../../../docs/plans/agent-hub-multi-agent-harness.md).

## What it does

`agent-hub` is the supported home for the former standalone dispatcher features:

- **Dispatcher grid** — a live dashboard of fixed specialists from `.pi/agents/teams.yaml`.
- **Specialist delegation** — `dispatch_agent` sends writable tasks to configured specialists.
- **Research helpers** — `spawn_research` and `/research` launch read-only helper agents. Two
  `kind: research` personas ship by default: `researcher` (fast `gpt-5.3-codex-spark`) for simple
  reads and `deep-researcher` (`gpt-5.5` / xhigh) for hard, cross-cutting investigation. The
  orchestrator routes by persona; each persona's model + thinking level is shown in its catalog.
- **Human handoff path** — `ask_user` is exposed when `pi-ask-user` is available, so specialists can
  bubble decisions back through the dispatcher.
- **Auto-research pipe (`NEEDS_RESEARCH:`)** — a specialist that lacks information pauses by ending
  its turn with `NEEDS_RESEARCH: <question>` lines (mirror of the `ASK_USER:` protocol). The hub
  intercepts them **in code**: it fans out read-only research helpers (max 4 questions per pause,
  2 pauses per dispatch), writes each helper's findings to `.pi/agent-sessions/findings/*.md`, and
  resumes the specialist's session with the file paths. The dispatcher LLM sees only a one-line
  notice — raw findings never enter its context. Findings files are wiped at session start.
- **Verification Contract (assertion ledger)** — the dispatcher owns a ledger of checkable
  acceptance assertions built from the request *before* any builder runs, so a clearly stated
  requirement is never silently dropped. `set_assertions` records the numbered, tagged assertions
  (`test` | `runtime-ui` | `code-grep` | `manual`, one pass condition each) and rebuilds the whole
  ledger on a "wrong again" regression reset; `update_assertion` marks each one proven (named
  evidence required), unproven, or failed after a verification gate; `get_assertions` reads the
  full ledger (ids, tags, pass conditions, evidence) back. The hub persists the ledger to
  `.pi/agent-sessions/assertions.json` (wiped at session start like `findings/`) and renders a
  one-line status (`Assertions: 2✓ 1○ 1✗ · open: A4`) so the contract survives compaction without
  re-flooding the dispatcher LLM context — after a compaction the dispatcher calls `get_assertions`
  to recover the full text the status line omits. The `orchestrator` persona drives it — a deep-researcher
  parity inventory for "behave like" requests, runtime proof for UI/visibility assertions, the
  regression reset on a re-ask — per
  [`orchestration-verification`](../../../skills/orchestration-verification/SKILL.md). **Advisory by
  design** (PRD open question 2): status is surfaced and "proven" requires named evidence, but a
  dispatch is never hard-refused on an unproven assertion — code-enforcement is the Checkpoint A
  decision.
- **Agent controls** — `/zoom` inspects a live agent timeline; `/agents-history` replays the run as a
  timeline (orchestrator turns, dispatches, research helpers) with per-agent durations, parallel-run
  markers, and a grand total; kill/restart controls manage running child agents; per-agent `model:`
  fields select models from team config.
- **Model switching** — a persona's frontmatter `models:` list declares the models it may switch to
  (the default `model:` is implicitly a candidate). `/agent-model <persona>` picks from that list;
  the choice lasts for the session and takes effect on the persona's next dispatch
  (`/agents-restart <persona>` applies it immediately). The dot form
  `/agent-model <persona>.<role>` switches a delegate sub-role's model instead — its candidates are
  the role's declared default plus the parent persona's own candidate list; the switch is applied
  when the parent is next dispatched (it lands in the serialized delegate config, so nested
  children inherit it). `/models [profile]` applies a named profile
  from `.pi/agents/model-profiles.yaml` — a macro over the same declared candidates, validated at
  session start (a profile with any entry outside a persona's candidates is dropped whole, with an
  error); profiles never touch sub-role models — only `/agent-model` reaches those. Nothing
  outside the declared lists is ever selectable. Per project,
  `model.<persona>:` / `models.<persona>:` keys under `## agent-team` in
  `.ai/agent-skills-overrides.md` replace a persona's default model / candidate list.
  Research personas (`researcher` / `deep-researcher`, `kind: research`) are switchable the same
  way — `/agent-model <persona>` and `/agent-model-thinking <persona>` accept them alongside team
  members. Since research helpers are spawned fresh on each `/research` / `spawn_research`, the
  switch lands on their next spawn (there is no running instance to `/agents-restart`).
  `/agent-models-substitute <source> <target>` is the global one-shot form: walks every loaded
  persona (team + research + orchestrator), and for each whose **current effective model** is
  `<source>` and whose declared candidates include `<target>`, sets the session override to
  `<target>`. One-step flow — the dry-run summary (affected vs skipped, with reasons) is shown
  inline, then the swap is applied immediately and takes effect on each persona's next dispatch
  (`/agents-restart` to apply now). It never touches the dispatcher or delegate sub-roles.
- **Thinking levels** — each persona's frontmatter `thinking:` sets its pi `--thinking`
  reasoning effort (`off` · `minimal` · `low` · `medium` · `high` · `xhigh`). `/agent-model-thinking
  <persona>` switches it among those six levels for the session; like a model switch it takes effect
  on the persona's next dispatch (`/agents-restart <persona>` applies it now), and selecting the
  frontmatter default clears the override. The level shows as a short badge after the model
  everywhere a model is rendered — `gpt-5.5 (xh)` in the dashboard cards and the compact below-editor
  view (`min`/`low`/`med`/`hi`/`xh`; `off` shows no badge). Per project, a `thinking.<persona>:` key
  under `## agent-team` in `.ai/agent-skills-overrides.md` replaces a persona's default level.
- **Mid-turn delegation (`delegate` tool)** — a persona that declares a `subagents:` map in its
  frontmatter (`role: { model, tools? }` entries, or an indented `model:`/`tools:` block per role)
  gets a real mid-turn `delegate(role, instruction, context?, allow_write?)` tool, injected as an
  extra `-e delegate.ts` extension into its spawned process (the `delegate` tool name is appended to
  its `--tools` allowlist — pi filters extension tools too). Only declared roles are spawnable, on
  their declared models — model choice is configuration, never the child LLM's. Budgets are readable
  refusals: at most 4 delegate children per dispatch, tree-wide, and a per-persona `delegate_depth:`
  budget capped at 1 (the default). Children spawned with remaining depth 0 do not receive the
  `delegate` extension/tool. Write safety: children run read-only (`read,grep,find,ls`) unless a
  SINGLE live child gets `allow_write: true`, which inherits the parent's tools intersected with the
  role's `tools:` cap; if a declared role cap leaves no available tools, delegation is refused.
  Concurrent children are always forced read-only. Children report through
  `.pi/agent-sessions/delegations/<persona>/events.jsonl`; the hub tails it and renders nested rows
  under the parent's card (child id, model, tokens, status),
  each openable with `/zoom <child-id>`. Spend rolls up: every child row and the parent's subtree
  total show tokens, and a session-wide `Δ delegated` counter sits in the status line.
  `/agents-kill` on the parent SIGTERMs its whole process group, so the delegation tree dies with
  it. `context: fork` is accepted but treated as a summary brief in v1. Per project,
  `subagents.<persona>.<role>:` and `delegate-depth.<persona>:` keys under `## agent-team` in
  `.ai/agent-skills-overrides.md` replace individual sub-roles / the depth budget. Six personas
  ship with declared sub-roles, on a three-tier OpenAI model ladder — `gpt-5.3-codex-spark` for
  recon/grep sweeps, `gpt-5.4` for analysis sweeps, the `gpt-5.5` (or opus) parent reserved for
  synthesis and verdicts:
  - `code-reviewer` — `preflight`+`docs` (spark), `quality`+`perf` (gpt-5.4); its first delegate
    call is always `preflight`, which studies the project rules and the files under review and
    returns a summary that drives the rest of the fan-out. Deep security review is not a
    sub-role — it belongs to the separate `security-auditor` persona, which the reviewer
    recommends dispatching when it spots deeper risk.
  - `planner` — `scout`+`rules` (spark) fan out before the plan is drafted; `risk` (gpt-5.4)
    optionally challenges the draft breakdown.
  - `plan-reviewer` — `feasibility` (gpt-5.4) checks plan claims against the actual codebase;
    `deps` (spark) verifies dependency ordering and file overlap. No preflight — the plan is
    the map.
  - `security-auditor` — solo `recon` (spark) maps the attack surface first, then
    `input-sweep` (gpt-5.4) and `secrets-sweep` (spark) fan out; exploit reasoning stays with
    the parent.
  - `builder` — `recon` (spark) maps call sites before edits; `verifier` (spark, the one
    `allow_write: true` child) runs the test suite after them. Implementation is never
    delegated.
  - `test-engineer` — `coverage-scout`+`conventions` (spark) inventory gaps and test patterns;
    test writing is never delegated.
- **Dispatcher persona gate** — optional `persona-gate: on` can require an orchestrator persona at
  session start; by default the dispatcher starts without the gate.
- **Default damage-control guardrails** — `just hub` and `just hub-solo` load the
  `damage-control-continue` harness before `agent-hub`, so dispatcher tool calls are checked against
  `.pi/damage-control-rules.yaml` and a blocked call feeds back instead of aborting the turn. A
  guardrail is also re-loaded into every spawned subagent (see [Safety scope](#safety-scope)):
  research helpers get the same continue variant, other specialists get the hard-stop `damage-control`.
- **Embedded coms** — the dispatcher is a discoverable peer on the local machine. Multiple
  `agent-hub` (or plain `coms`) sessions on the same box find each other through per-project registry
  files and exchange messages over a unix socket (named pipe on Windows).

Inherited `/zoom` behavior in this harness expands the latest event by default. Use `Space` or
`Ctrl+C` to copy the selected row content, and `Q` or `Esc` to close the overlay. The overlay sizes
to the terminal and keeps the selected (and last) entry fully visible while you navigate with
`↑/↓`.

### `/agents-history`

`/agents-history` opens a read-only overlay (same chrome as `/zoom`) that replays the session as an
execution **tree**:

- **Orchestrator turns** — each dispatcher turn that actually dispatched something is a depth-0 row
  labelled `(dispatcher)`. Chat-only turns add no rows.
- **Dispatched specialists and research helpers** nest one level beneath the turn that launched them;
  **delegate sub-sub-agents** nest one level deeper still under the specialist that spawned them — in
  start order at every level.
- **Parallel runs** — siblings whose run times overlap are marked with a `│→` connector, so a
  concurrent fan-out reads as a visually grouped block.
- **Real-work durations** — each row shows that node's *own* work: its span **minus the time it spent
  awaiting children**. A dispatcher blocked on six concurrent agents is credited only for the time it
  actually worked between/around the awaits, never for the await itself — so the same wall-clock isn't
  counted twice up the tree. The same subtraction applies to a specialist awaiting its own delegate
  children. Format: plain seconds under a minute (`42sec`), `m:ss` above it (`10:20min` for 620s).
  Running rows tick live (the overlay re-renders once a second) and a new dispatch appears the instant
  it starts.
- **Footer** shows `Σ real work <total> · <n> runs (agents <a> + dispatchers <d>)` — the real work of
  *everyone*: the dispatched specialists' and research helpers' full runtime (`agents`) plus each
  dispatcher turn's own work (`dispatchers` — its span minus the time it awaited agents **and** the
  human via `ask_user`). Wall-clock is deliberately **not** shown: it would fold in the idle gaps
  while you're away between turns, and `ask_user` waits are subtracted for the same reason.

Navigate with `↑/↓`, press `G` to jump back to the live tail, and `Q`/`Esc` to close. The log resets
on each session start.

Press **`Alt+A`** to toggle the agent view between the full **dashboard** (bordered card grid drawn
*above* the input box) and a **compact** view that shows one line per *running* agent —
`name · context% · state` — rendered *below* the input box, just above pi's status bar. Idle and
done agents are hidden in compact mode, and the coms pool widget collapses too, so an idle session
collapses to just the prompt and footer. The current mode and binding are shown in the footer
(`Alt+A view:dashboard` / `Alt+A view:compact`).

### Compact-view agent switcher

In **compact view**, the running-subagents list below the input doubles as a switcher. **`Alt+]`**
and **`Alt+[`** move a marker (`›` + highlight) to the next/previous running subagent; **`Alt+\`**
opens the read-only `/zoom` overlay on the marked one (`Q`/`Esc` to close). This only changes what
you *view* — **the input box always prompts the main session**, and `main` is never a marker target
(it is the session under the input, not a subagent). There is no transcript takeover: a subagent's
stream is surfaced through the modal zoom overlay, never by replacing the main scrollback. The keys
are inert in dashboard mode (use `/zoom <name>` there).

> Terminal note: `Alt+[` emits `ESC [` (a CSI prefix) and may be swallowed by some terminals'
> escape parsers; `Alt+]` and `Alt+\` are the reliable pair. `Alt+↑/↓/←/→` are reserved by the pi
> editor, which is why the switcher uses the bracket/backslash keys.

## Configuration

At session start, `agent-hub` reads `.ai/agent-skills-overrides.md` in the workspace. The
user-facing language override keeps the legacy `## agent-team` section name:

```markdown
## agent-team
# Replace Bulgarian with any language name.
language: Bulgarian
```

Omit the section to keep the default `English`. `language` applies to dispatcher replies,
`ask_user` questions and `context` fields, handoff summaries, and user-facing status text;
specialist task strings stay in English.

The same section can point the team at the project's own rule files:

```markdown
## agent-team
rules: docs/rules, .ai/rules
```

`rules:` lists repo-relative folders, each searched **recursively** through all subfolders. When
set, every dispatched specialist's system prompt gains a "Project rules" block naming the folders;
the planner and code-reviewer personas additionally validate their subject against the relevant
rules and pass them on (cited in plan acceptance criteria / handed to delegate sub-reviewers).
Folders that don't exist produce a session-start warning, never an error. The full key list for
`## agent-team` (models, sub-roles, depth budgets, persona gate) is documented in
`docs/agent-skills-setup.md`.

## The coms layer

### Identity

Each session registers a coms identity at start-up, resolved in this precedence order:

1. **CLI flags** — `--name`, `--purpose`, `--project`, `--color`, `--explicit`
2. **Dispatcher persona frontmatter** — `name`, `description` (→ purpose), `color` from the
   selected `kind: orchestrator` persona (see [persona sync](#persona--coms-purpose-sync))
3. **Defaults** — auto-generated name `hub-<id>`, purpose `agent-hub dispatcher`, project
   `default`, a deterministic color derived from the session id

Names are de-duplicated per project (`resolveUniqueName`), so two hubs that both want `architect`
become `architect` and `architect-2`. `--explicit` marks a **private** peer — kept out of every
pool by default, so it is neither listed nor reachable until a human opts in with `/coms --all`
(see [Pool scope is the reach boundary](#pool-scope-is-the-reach-boundary)). The registry lives
under `~/.pi/coms/projects/<project>/agents/<name>.json` and is created at runtime.

### Commands & tools (local dispatcher plus coms)

- `/coms` — coms control surface (peer list / status)
- `/handoff <peer>` — hand the whole session off to a coms peer (see [Handoff](#handoff))
- `coms_list` — discover the peers in your pool: names, models, live context usage, purpose. Scoped
  to your project and excluding private peers; the LLM cannot widen it (see
  [Pool scope is the reach boundary](#pool-scope-is-the-reach-boundary)).
- `coms_send` — send a prompt to a peer **in your pool**; returns a `msg_id`
- `coms_await` — **block** until that `msg_id`'s reply lands (default 30 min,
  `PI_COMS_TIMEOUT_MS`)
- `coms_get` — **non-blocking** poll of a `msg_id` (status `pending|complete|error`)

`/coms` and `/handoff` tab-complete live peer names **in your pool**.

### Pool scope is the reach boundary

The set of peers shown in the pool widget is the security boundary: **a peer is reachable only if it
is in your pool.** `coms_list`, `coms_send`, and `/handoff` all resolve targets through the same
`peersInScope()` helper, so the dispatcher can never message a peer it cannot see. Two knobs define
the pool, and **both are human-only** — the LLM cannot widen scope to reach more peers:

- **Project** — defaults to your own `identity.project`. A human can retarget with `/coms --project
  <name>` (one project) or `/coms --all` (every project). `coms_list`'s own parameters cannot
  override this; an LLM request for a wider project is clamped back to the current pool and flagged.
- **Explicit (private) peers** — excluded from every pool by default. `/coms --all` opts them in.

This closes a cross-project leak where a peer reachable through the mesh was *not* shown in the
default project-scoped pool — so it could be messaged without being "connected." Now the reachable
set is always a subset of what the widget shows. To reach a peer outside the pool, a human widens
scope first; the dispatcher is told to **ask** rather than attempt it, and not to pass cross-project
context to a peer the human has not approved.

### Peer as subagent

The dispatcher uses a peer as a subagent by pairing the tools: `coms_send(target, prompt)` to
issue the task, then `coms_await(msg_id)` to block for the reply (or `coms_get` to poll). This sits
alongside `dispatch_agent` — local persona specialists are dispatched as subprocesses; remote peers
are reached over coms. The two paths stay explicit. (The specialist-level `delegate` tool is a third,
nested path: a dispatched specialist spawning its own declared sub-agents — it does not auto-route
between local and remote either.) Multi-hop is inherited from coms: a peer handling a dispatched task can `coms_send`
onward, hops accumulating up to `MAX_HOPS` (5).

### Handoff

`/handoff <peer>` transfers the session to another **main** agent. Following the plan's
**decision G1**, it does *not* try to extract a compaction summary; instead it asks the dispatcher
LLM to compose a **self-contained brief** ("everything the target needs, assume no shared history"),
then `coms_send`s that brief to the peer, `coms_await`s the reply, and relays it back — in the
configured user-facing language. The target peer takes over; the source relays the result. There is
no raw session copy (pi sessions aren't portable between live agents). The target must be a peer in
your pool — `/handoff` resolves through the same [scope boundary](#pool-scope-is-the-reach-boundary)
as `coms_send`, so you cannot hand a session to a peer you cannot see.

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
local dispatcher without coms: the `coms_*` tools are withheld from `setActiveTools`, the
`/handoff` command refuses with a notice, and the "Peer agents (coms)" prompt section is omitted.
Orchestration, research helpers, and the grid keep working.

### Tool surface

`setActiveTools` always preserves the orchestration surface and adds coms when ready:

```ts
const dispatcherTools = ["dispatch_agent", "spawn_research", "set_assertions", "update_assertion", "get_assertions"];
if (comsReady)        dispatcherTools.push("coms_list", "coms_send", "coms_get", "coms_await");
if (askUserAvailable) dispatcherTools.push("ask_user");
```

`set_assertions` / `update_assertion` / `get_assertions` are the always-on Verification Contract ledger tools (see
[What it does](#what-it-does)); like `dispatch_agent` / `spawn_research` they are part of the
orchestration surface the dispatcher persona never narrows.

The dispatcher persona is **flavor-only** (decision G4 / 9) — it enriches the role but never narrows
this tool set, so coms and dispatch stay available regardless of the chosen persona.

## Requires

- `.pi/agents/teams.yaml` for fixed specialist teams, the referenced persona `.md` files, and
  (strongly recommended) [`pi-ask-user`](https://github.com/edlsh/pi-ask-user).
- `.pi/damage-control-rules.yaml` for the default guarded `just hub` / `just hub-solo` recipes.
- Nothing extra in-repo for coms — the peer registry lives at `~/.pi/coms/` and is created at
  runtime.

## Usage

```bash
# via the justfile (loads damage-control-continue first; accepts coms identity flags)
just hub
just hub --name architect --purpose "owns the migration design" --project myrepo

# equivalent direct guarded launch
pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts
pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts --name releaser --explicit

# direct unguarded launch, only when you intentionally want to skip damage-control
pi -e .pi/harnesses/agent-hub/index.ts
```

Identity flags: `--name`, `--purpose`, `--project`, `--color`, `--explicit`.

### Safety scope

`just hub` and `just hub-solo` load `damage-control-continue` before `agent-hub`, so guardrails apply
to hub/dispatcher tool calls in that parent pi process — and because it is the *continue* variant, a
blocked dispatcher call feeds back and the turn keeps going rather than aborting. Specialist and
research agents are spawned as separate pi subprocesses with `--no-extensions` — but `agent-hub`
resolves a damage-control harness (from this session's `-e` flags, else the repo-local
`.pi/harnesses/<variant>/index.ts`) and re-loads *only* that one into each child via `-e`. The variant
is chosen per child: research helpers (`researcher` / `deep-researcher`) get `damage-control-continue`
so a blocked read lets them adapt and keep going; every other specialist gets the hard-stop
`damage-control` that aborts on a violation. (Continue falls back to the hard-stop variant when it
isn't installed, so researchers stay guarded either way.) `--no-extensions` keeps discovery off, so
children never auto-load the `.pi/extensions/` utilities or recursively re-load `agent-hub`; the
explicit `-e` still applies, so every child's tool calls are checked against the same
`.pi/damage-control-rules.yaml`. If damage-control can't be resolved, a session-start warning is
shown and children spawn unguarded. Research helpers are additionally read-only by construction.
The guided setup (`guided-workspace-setup`) enforces the pairing: installing or keeping `agent-hub`
always installs/keeps `damage-control` (and `damage-control-continue`) with it.

### Related recipes

```bash
# the hub without the coms layer (fixed specialists + research only — lighter)
just hub-solo

# spawn every peer of a team from .pi/agents/peers.yaml into tiled tmux panes
just team-up full        # launch
just team-up-dry full    # print the resolved hidden peer-launch commands without launching
```

`peers.yaml` groups reusable peers into named teams; each entry is `name` / `persona`
(+ optional `model`). The persona's frontmatter `description`/`color` become the peer's
coms purpose/color.

## How it differs from its sources

- **Embedded, not stacked (decision 1).** coms is folded into this one `index.ts`; the identity
  flags are registered once. Loading `coms` as a second `-e` would double-register
  `--name/--purpose/...` and abort start-up.
- **Single `session_start`.** coms init is folded into the former dispatcher's `session_start` and
  guarded by `if (!comsReady)`, so `/new` reuses the same peer identity (no leaked socket).
- **Dispatcher is also a peer.** `setActiveTools` lists `coms_*` alongside `dispatch_agent` +
  `spawn_research` (+ `ask_user`); the system prompt gains a "Peer agents (coms)" section when coms
  is ready. The persona's `description` drives the coms `purpose` (decision 6 / Phase 6 peer
  mapping) instead of a static `--purpose`.
- **`/handoff` uses an LLM-composed brief**, not a compaction-summary extraction (decision G1).
- **Clean shutdown** SIGTERMs any running specialist/research children, clears the coms pool
  widget, and removes the registry entry on `session_shutdown` / SIGINT / SIGTERM.
