# purpose-gate

Forces the engineer to declare intent before working.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

On session start it immediately asks "What is the purpose of this agent?" via a text
input dialog and **blocks all prompts until answered**. A persistent widget then shows
the declared purpose for the rest of the session, keeping the work anchored to one
stated goal.

## Commands & tools

None — a session-start dialog plus a persistent widget.

## Usage

```bash
pi -e .pi/harnesses/purpose-gate/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
