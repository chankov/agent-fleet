# damage-control-continue

Safety auditing — blocks destructive tool calls, but lets the agent **adapt and keep working**.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Same rule engine as [`damage-control`](../damage-control/README.md) — it loads
`.pi/damage-control-rules.yaml` (`bashToolPatterns`, `zeroAccessPaths`,
`readOnlyPaths`, `noDeletePaths`) and checks every tool call against it.

The difference is what happens on a match:

- **`damage-control`** replaces the tool result with a block message **and calls
  `ctx.abort()`**, ending the agent's turn (hard stop).
- **`damage-control-continue`** replaces the tool result with **actionable
  feedback** that distinguishes destructive from non-destructive intent and tells
  the agent how to adapt — and does **not** abort. The turn continues, so the
  agent can recover (e.g. assume a `.env` key exists instead of reading it to
  verify) instead of dead-ending.

Both variants still hard-block; neither lets the restricted call through. The
choice is only whether the agent's turn dies or keeps going.

## When it's used (this repo)

`just hub` / `just hub-solo` load this variant for the **orchestrator/dispatcher
main session**, and the hub re-loads it into spawned **research helpers**
(`researcher` / `deep-researcher`) — both need to recover from a blocked read and
keep going rather than abort. Every other spawned specialist (builder,
test-engineer, …) keeps the hard-stop `damage-control` harness.

## Commands & tools

None — it runs passively on the `tool_call` event.

## Requires

- `.pi/damage-control-rules.yaml` — the rule set (shipped in this repo)

## Usage

```bash
# standalone continue-mode guardrail session
just ext-damage-control-continue
pi -e .pi/harnesses/damage-control-continue/index.ts

# the hub recipes load this variant for the main agent by default
just hub
just hub-solo

# direct continue-guarded hub launch
pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
- The `find` tool's `pattern` is matched against `zeroAccessPaths` (mirrors the
  hardening in this repo's `damage-control`), closing a gap where `find` could
  still locate secret files.
