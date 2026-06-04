# agent-team

Dispatcher-only orchestrator with a grid dashboard. The dispatcher talks to the human
in a configurable language (**English** by default; per-project override in
`.ai/agent-skills-overrides.md`) and acts as a single funnel for clarification:
specialists bubble up questions through it instead of guessing.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

The primary pi agent has **no codebase tools** — it can only delegate work to specialist
agents via the `dispatch_agent` tool, spawn read-only research helpers via `spawn_research`
(see [Research helpers](#research-helpers)), and ask the human for input via `ask_user`.
Each specialist keeps its own pi session for cross-invocation memory. A live grid dashboard
shows each agent's status.

Agent definitions are loaded from `agents/`, `.claude/agents/`, and `.pi/agents/`. Teams
are defined in `.pi/agents/teams.yaml`; on boot a select dialog lets you pick a team, and
only that team's members are available for dispatch.

## Commands & tools

- `/agents-team` — switch the active team
- `/agents-list` — list loaded agents (status, session, model, run count)
- `/agents-grid N` — set the dashboard column count (default 2)
- `/agents-kill <name>` — SIGTERM a frozen specialist (see [Kill & restart](#kill--restart))
- `/agents-restart <name>` — kill it and re-run its last task on a fresh session
- `/zoom <name|rN>` — scrollable read-only view of an agent's live stream (see [Zoom](#zoom)); works on team members *and* research helpers
- `/research [@persona] [--model <spec>] <task>` — spawn a read-only research helper (see [Research helpers](#research-helpers))
- `/research-cont rN <prompt>` — resume a finished research helper on its session
- `/research-rm rN` — remove a research helper (SIGTERM if running)
- `/research-clear` — remove all research helpers
- `/persona` — select or reset the dispatcher persona (see [Dispatcher persona gate](#dispatcher-persona-gate))
- `dispatch_agent` tool — delegate a sub-task to a specialist
- `spawn_research` tool — the dispatcher's own way to run a read-only research helper and fold its findings into a specialist's task (see [Research helpers](#research-helpers))
- `ask_user` tool — provided by the [`pi-ask-user`](https://github.com/edlsh/pi-ask-user)
  companion package when installed. This harness does **not** register its own
  `ask_user` (any in-harness registration would conflict with `pi-ask-user`
  regardless of load order). At session start the harness probes for `ask_user`
  via `pi.getAllTools()`; if present, it's gated into the dispatcher's tool
  surface and the system prompt drives the agent to use it. If absent, the
  dispatcher operates in a degraded "state assumptions explicitly" mode and the
  user is warned to install `pi-ask-user`.

## Communication model

- **Dispatcher → user:** the language configured by `language:` under `## agent-team`
  in `.ai/agent-skills-overrides.md`. **Default: English.** Every `ask_user` question,
  every summary, is in that language.
- **Dispatcher → specialists:** English. Specialist personas are written in English;
  the task strings stay in English so they perform as designed — regardless of the
  user-facing language.
- **Specialists → dispatcher:** if a specialist needs clarification it emits a line of
  the form `ASK_USER: <question>` and stops. The dispatcher extracts these from the
  output, surfaces them via `ask_user` in the configured language (translating from
  the specialist's English if needed), then re-dispatches the specialist with the
  answer. Specialists themselves have no access to `ask_user` — by design, so the
  dispatcher remains the only thing talking to you.

## Kill & restart

Specialists run as `pi` subprocesses and occasionally wedge — a flaky install step, a
provider stall — leaving the grid card stuck on `running` forever. Two commands recover
without restarting the whole session:

- **`/agents-kill <name>`** — sends `SIGTERM` to the specialist's child process. The card
  frees (returns to `idle`) and the dispatcher's in-flight `dispatch_agent` call returns a
  *"killed by operator — do not auto-retry; wait for instruction"* result, so the LLM
  doesn't immediately re-dispatch. Use this to unstick a frozen run, then decide what to do.
- **`/agents-restart <name>`** — kills the current run (if any) and re-runs the specialist's
  **last task** on a **fresh session** (a frozen session file may be inconsistent, so it
  starts clean — no `-c`). The fresh result is delivered to the dispatcher as a follow-up
  turn.

Both commands work *while a dispatch is in flight*: pi executes extension slash commands
immediately, even during a foreground awaited tool, so the kill lands and unblocks the
awaited `dispatch_agent`. Tab-completion lists loaded agent names with their current status.

## Zoom

The grid card shows only a specialist's *last* line. `/zoom <name>` opens a scrollable,
read-only overlay of that specialist's full stream — coalesced assistant text, each tool
call (name + arguments), and (opt-in) its thinking — so you can watch a long run or
diagnose a freeze without tailing the session file.

- **Live.** While the overlay is open it updates as new events stream in (throttled), and
  follows the tail until you scroll up with `↑`. `Enter` expands the selected entry, `Esc`
  closes. Like the kill/restart commands, `/zoom` opens *while a dispatch is in flight*.
- **Persists.** The timeline is kept after the run finishes, so a post-hoc `/zoom` still
  works — it's cleared only when that agent starts its next run.
- **No file parsing.** The timeline is built from the JSON event stream the harness already
  consumes for the dashboard; it does not read the session file. Built on the same overlay
  primitive (`ctx.ui.custom`) as the `session-replay` harness.

### Capturing thinking

By default specialists run with `--thinking off`, so the timeline has only text and tool
calls. To capture a specialist's reasoning (e.g. to debug *why* it wedged), set a
`thinking:` level in its persona frontmatter:

```markdown
---
name: scout
description: Read-only reconnaissance …
tools: read,grep,find,ls
thinking: low
---
```

- **Values:** any pi `--thinking` level — `off` (default), `minimal`, `low`, `medium`,
  `high`, `xhigh`. The truthy words `on`/`true`/`yes`/`1` map to `low`; anything else maps
  to `off`. When non-`off`, thinking deltas are captured into the zoom timeline (marked
  with a `💭` icon).
- **Cost.** Higher levels spend more tokens and latency on reasoning — leave it `off` for
  routine members and flip it on only when debugging.

## Research helpers

Alongside the standing team, the dispatcher can spawn **read-only research helpers** —
ephemeral agents that assist with reconnaissance, code search, and reading docs. They are
**read-only by construction**: every helper runs with `--tools read,grep,find,ls` —
**never bash, never write/edit** — regardless of what its persona declares. That's the
defining line between a *research helper* and a full *specialist*.

Helpers render in their own widget row, labelled **`research`**, below the team grid, so
they read as visibly distinct from the standing team. Each gets a numeric handle `rN`.

### Two flavours

- **Persona-based** — a persona `.md` tagged `kind: research` in its frontmatter. It
  brings its own role, `model:`, and `thinking:` (consistent with fixed members), but its
  tools are forced read-only. Spawn by name: `spawn_research(persona: "researcher")` or
  `/research @researcher <task>`.
- **Ad-hoc / anonymous** — no persona, for one-off lookups. `spawn_research(task: …)` or
  `/research <task>`. Takes an optional model: `/research --model anthropic/claude-opus-4-7 <task>`
  (or the `model` arg on the tool).

A starter persona ships in `.pi/agents/researcher.md`. Drop your own `kind: research`
file in `agents/` or `.pi/agents/` to add more.

### Who spawns them, and why the dispatcher fans out

Dispatched specialists run `--no-extensions` with **no dispatch tool**, so they *cannot
spawn their own helpers*. When a specialist needs research help, the **dispatcher fans
out**: it runs `spawn_research`, collects the findings, and folds them into the
specialist's task. The dispatcher's `spawn_research` returns the findings **inline** (it
awaits the helper). The human-facing `/research` command is fire-and-forget — its result
is delivered back to the dispatcher as a follow-up turn.

### Lifecycle

- **Ephemeral by default.** Helper session files live under `.pi/agent-sessions/` as
  `research-<id>.json` and are wiped on every session start.
- **Resumable** mid-session: `/research-cont rN <prompt>` continues a finished helper on
  its existing session (subcont-style, bumping the turn counter).
- **Clearable:** `/research-rm rN` removes one (SIGTERM if running); `/research-clear`
  removes all.
- **Zoomable:** `/zoom rN` opens the same scrollable overlay used for team members.

## Configuration

Per-project overrides live in `.ai/agent-skills-overrides.md` under a `## agent-team`
section (see [docs/agent-skills-setup.md](../../../docs/agent-skills-setup.md)).

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `English` | User-facing language. The dispatcher writes every `ask_user` question, every `context` field, and every summary in this language. Specialist task strings stay in English regardless. |
| `persona-gate` | `off` | When `on`, blocks input on session start until you pick a dispatcher persona (see [Dispatcher persona gate](#dispatcher-persona-gate)). Accepts `on`/`true`/`yes`/`1`. |

Example:

```markdown
## agent-team
language: Bulgarian
persona-gate: on
```

The clarification protocol is injected automatically into every dispatched task — you
do not need to edit your specialist personas to opt in.

### When the dispatcher will ask

- Requirements are ambiguous, incomplete, or contradictory.
- Multiple valid approaches exist and the trade-off is preference-dependent.
- A specialist emitted an `ASK_USER:` marker.
- A specialist's output contradicts another specialist's or your stated requirement.
- The next dispatch is destructive or irreversible.
- The dispatcher is about to assume a value (path, version, flag, threshold) you
  didn't specify.

## Per-agent model

Each persona can declare its own model in frontmatter via the `model:` key. The dispatcher
spawns that specialist on the declared model; when unset, the specialist inherits the
dispatcher's model (the original behaviour). This lets you, say, run the reviewer on a
strong model while the implementers run on a cheaper, faster one.

```markdown
---
name: code-reviewer
description: Senior code reviewer …
tools: read,bash,grep,find,ls
model: anthropic/claude-opus-4-7
---
```

- **Format:** the value is passed verbatim to `pi --model`, so use a spec your pi accepts.
  The canonical form is `provider/model-id` (e.g. `anthropic/claude-opus-4-7`); pi's short
  aliases also pass through (`.pi/agents/bowser.md` uses `model: opus`).
- **Fallback:** a persona with no `model:` runs on the dispatcher's model.
- **Visibility:** the resolved model shows in `/agents-list` and on each grid card.
- **Errors:** a bad `--model` (or a provider whose API key isn't configured) makes the
  spawned `pi` exit non-zero; its stderr is now surfaced in the dispatch result instead of
  failing silently.

> **Cross-tool caveat.** If a persona `.md` is *also* used as a Claude Code subagent (e.g.
> the files under `agents/` that are symlinked into `.pi/agents/`), note that Claude Code's
> `model:` field expects `opus`/`sonnet`/`haiku`/`inherit`, not a full pi spec. Keep a
> pi-only `model:` value on pi-only personas to avoid a format clash.

## Dispatcher persona gate

Every agent runs a declared **persona (role)** — and that includes the dispatcher itself.
The dispatcher's persona is sourced from an **orchestrator persona** file: a normal persona
`.md` tagged with `kind: orchestrator` in its frontmatter.

```markdown
---
name: orchestrator
description: Balanced orchestrator — scout, plan, build, review in small increments.
kind: orchestrator
---

# Balanced Orchestrator
You coordinate the team in small, verifiable increments. …
```

- **The gate.** With `persona-gate: on`, the harness blocks input on session start until you
  pick one of the discovered orchestrator personas (a select dialog opens automatically). This
  mirrors the old purpose-gate, but with a reusable, versioned persona instead of free text.
  The gate self-disables if no `kind: orchestrator` personas exist, so it never traps you with
  nothing to pick.
- **Flavor-only — never narrows tools.** The chosen persona's body is merged *in front of* the
  orchestration prompt (persona first, then the orchestration rules). It enriches the
  dispatcher's role; it does **not** replace the orchestrator prompt and does **not** strip the
  dispatcher's tools (`dispatch_agent`/`ask_user` are always preserved). Dispatcher personas are
  therefore orchestrator-flavored *styles*, not arbitrary specialists.
- **Picker scope.** Only `kind: orchestrator` personas appear in the gate — your `builder` /
  `scout` specialists are filtered out (they make no sense as a dispatcher role).
- **Switch any time.** `/persona` re-opens the picker mid-session, or resets to the default
  (no persona / plain orchestrator prompt). Switching takes effect on the next turn.

Two starter orchestrator personas ship in `.pi/agents/`: `orchestrator` (balanced) and
`orchestrator-careful` (review-first). Add your own by dropping a `kind: orchestrator` file in
`agents/` or `.pi/agents/`.

> Fixed specialists are already persona-driven — each specialist `.md` *is* its role (body →
> `--append-system-prompt`, `tools` → `--tools`). The gate adds the missing piece: a declared
> persona for the dispatcher too.

## Requires

- `.pi/agents/teams.yaml` — team definitions
- `.pi/agents/*.md` — the agent personas (optional per-agent `model:`, `kind:`, and `thinking:`, see above). A persona tagged `kind: research` becomes a spawnable read-only [research helper](#research-helpers); `kind: orchestrator` becomes a dispatcher persona.
- **Strongly recommended:** [`pi-ask-user`](https://github.com/edlsh/pi-ask-user)
  installed in the global pi packages dir (`pi install npm:pi-ask-user`). Without
  it, the dispatcher cannot ask interactive questions — it falls back to "state
  assumptions explicitly and wait for the user's next turn" mode.

## Usage

```bash
pi -e .pi/harnesses/agent-team/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
- Dispatcher is now a true orchestrator: gates `pi-ask-user`'s `ask_user` into its
  tool surface when available, falls back to "state assumptions explicitly" mode
  otherwise. Adds configurable user-facing language (default English; override in
  `.ai/agent-skills-overrides.md`) and the `ASK_USER:` bubble-up protocol so
  specialists can route clarification through the dispatcher. None of this is in
  upstream `pi-vs-claude-code`.
- Read-only **research helpers** (`spawn_research` tool + `/research*` commands +
  `kind: research` personas + a dedicated "research" widget row), adapted from the
  `subagent-widget` spawn mechanic but forced read-only (no bash/write). The dispatcher
  fans research out to feed sandboxed specialists. Not in upstream.
