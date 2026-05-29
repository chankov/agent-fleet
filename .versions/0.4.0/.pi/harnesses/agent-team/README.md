# agent-team

Dispatcher-only orchestrator with a grid dashboard. The dispatcher talks to the human
in a configurable language (**English** by default; per-project override in
`.ai/agent-skills-overrides.md`) and acts as a single funnel for clarification:
specialists bubble up questions through it instead of guessing.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

The primary pi agent has **no codebase tools** — it can only delegate work to specialist
agents via the `dispatch_agent` tool and ask the human for input via `ask_user`. Each
specialist keeps its own pi session for cross-invocation memory. A live grid dashboard
shows each agent's status.

Agent definitions are loaded from `agents/`, `.claude/agents/`, and `.pi/agents/`. Teams
are defined in `.pi/agents/teams.yaml`; on boot a select dialog lets you pick a team, and
only that team's members are available for dispatch.

## Commands & tools

- `/agents-team` — switch the active team
- `/agents-list` — list loaded agents
- `/agents-grid N` — set the dashboard column count (default 2)
- `dispatch_agent` tool — delegate a sub-task to a specialist
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

## Configuration

Per-project overrides live in `.ai/agent-skills-overrides.md` under a `## agent-team`
section (see [docs/agent-skills-setup.md](../../../docs/agent-skills-setup.md)).

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `English` | User-facing language. The dispatcher writes every `ask_user` question, every `context` field, and every summary in this language. Specialist task strings stay in English regardless. |

Example:

```markdown
## agent-team
language: Bulgarian
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

## Requires

- `.pi/agents/teams.yaml` — team definitions
- `.pi/agents/*.md` — the agent personas
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
