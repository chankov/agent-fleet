# agent-team

Dispatcher-only orchestrator with a grid dashboard.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

The primary pi agent has **no codebase tools** — it can only delegate work to specialist
agents via the `dispatch_agent` tool. Each specialist keeps its own pi session for
cross-invocation memory. A live grid dashboard shows each agent's status.

Agent definitions are loaded from `agents/`, `.claude/agents/`, and `.pi/agents/`. Teams
are defined in `.pi/agents/teams.yaml`; on boot a select dialog lets you pick a team, and
only that team's members are available for dispatch.

## Commands & tools

- `/agents-team` — switch the active team
- `/agents-list` — list loaded agents
- `/agents-grid N` — set the dashboard column count (default 2)
- `dispatch_agent` tool — the only tool the primary agent has

## Requires

- `.pi/agents/teams.yaml` — team definitions
- `.pi/agents/*.md` — the agent personas

## Usage

```bash
pi -e .pi/harnesses/agent-team/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
