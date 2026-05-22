# damage-control-continue

Safety auditing that lets the agent recover instead of aborting.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Same rule engine as [`damage-control`](../damage-control/README.md) — it reads the same
`.pi/damage-control-rules.yaml` — but it differs in how a blocked call is handled:

- the blocked tool result is replaced with **actionable feedback** that distinguishes
  destructive intent from merely non-destructive intent and tells the agent how to adapt;
- it does **not** call `ctx.abort()`, so the agent's turn continues and it can try an
  alternate path (e.g. assume a `.env` key exists rather than reading the file to verify).

Use this when you want guard rails without killing the turn; use plain `damage-control`
when a hard stop is preferred.

## Commands & tools

None — it runs passively on the `tool_call` event.

## Requires

- `.pi/damage-control-rules.yaml` — the rule set (shipped in this repo)

## Usage

```bash
pi -e .pi/harnesses/damage-control-continue/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
