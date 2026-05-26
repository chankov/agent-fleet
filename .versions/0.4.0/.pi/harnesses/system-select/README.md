# system-select

Switch the system prompt via `/system`.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Scans `.pi/agents/`, `.claude/agents/`, `.gemini/agents/`, and `.codex/agents/` — both
project-local and global — for agent definition `.md` files. `/system` opens a select
dialog to pick one; the chosen agent's body is prepended to pi's default instructions so
tool usage still works, and tools are restricted to the agent's declared tool set when
one is specified.

## Commands & tools

- `/system` — open the agent-persona picker

## Requires

- Agent definition `.md` files in any scanned directory. This repo ships a set under
  `.pi/agents/` (`scout`, `planner`, `builder`, `reviewer`, `documenter`, `red-team`, …).

## Usage

```bash
pi -e .pi/harnesses/system-select/index.ts
```

Pairs well with `minimal` as a lightweight footer:

```bash
pi -e .pi/harnesses/system-select/index.ts -e .pi/harnesses/minimal/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
