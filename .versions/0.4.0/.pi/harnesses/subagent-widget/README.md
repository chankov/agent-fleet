# subagent-widget

Background subagents with stacking live widgets.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

`/sub <task>` spawns a background pi subagent with its own persistent session and a live
widget that streams its progress. Multiple subagents stack as separate widgets, and each
can be resumed with a follow-up via `/subcont`.

## Commands & tools

- `/sub <task>` — spawn a new background subagent
- `/subcont <n> <task>` — continue subagent #n's conversation with a new prompt
- `/subrm <n>` — remove subagent #n's widget
- `/subclear` — clear all subagent widgets

## Usage

```bash
pi -e .pi/harnesses/subagent-widget/index.ts
```

Then, for example:

```
/sub list files and summarize
/subcont 1 now write tests for it
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
