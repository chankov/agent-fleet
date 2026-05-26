# tilldone

Work till it's done — task-driven discipline.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

A discipline extension (a play on "todo" → "tilldone"). The agent **must** declare what
it is going to do — via `tilldone add` — before it can use any other tool. When the agent
finishes a turn with tasks still incomplete, it is nudged to continue or mark them done.

Each task moves through a three-state lifecycle: `idle → inprogress → done`. Lists have a
title and description that give the tasks a theme; `new-list` starts a fresh list and
`clear` wipes tasks (with confirmation).

It surfaces the task state in four places: a footer task list with live progress, a
widget highlighting the current `inprogress` task, a compact status-line summary, and the
`/tilldone` interactive overlay.

## Commands & tools

- `/tilldone` — interactive overlay with full task details
- `tilldone` tool — `add`, `new-list`, `clear`, and state transitions

## Usage

```bash
pi -e .pi/harnesses/tilldone/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
