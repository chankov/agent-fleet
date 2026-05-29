# tool-counter-widget

Tool-call counts in a widget above the editor.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Shows a persistent, live-updating widget above the editor with per-tool call counts, each
tool tinted with its own background colour — e.g. `Tools (12): [Bash 3] [Read 7] [Write 2]`.
Unlike [`tool-counter`](../tool-counter/README.md), which is a full footer, this is a
compact widget you can stack with other footers.

## Commands & tools

None — widget only.

## Usage

```bash
pi -e .pi/harnesses/tool-counter-widget/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
