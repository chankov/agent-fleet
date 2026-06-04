# damage-control

Safety auditing — blocks destructive tool calls.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Intercepts every tool call and checks it against rules in `.pi/damage-control-rules.yaml`:

- `bashToolPatterns` — destructive shell commands (`rm -rf`, `git reset --hard`,
  `DROP TABLE`, cloud-resource deletes, …); some are hard-blocked, some marked `ask`
- `zeroAccessPaths` — secrets and credentials that must never be read (`.env`, `*.pem`, …)
- `readOnlyPaths` — paths that may be read but not written (lockfiles, build output, …)
- `noDeletePaths` — paths that may be edited but not deleted (`README`, `.git/`, …)

On a match the tool result is replaced with a block message and the agent's turn is
aborted (`ctx.abort()`). This hard-stop behavior is the only shipped damage-control mode.

## Commands & tools

None — it runs passively on the `tool_call` event.

## Requires

- `.pi/damage-control-rules.yaml` — the rule set (shipped in this repo)

## Usage

```bash
# standalone guardrail session
just ext-damage-control
pi -e .pi/harnesses/damage-control/index.ts

# the hub recipes load this harness first by default
just hub
just hub-solo

# direct guarded hub launch
pi -e .pi/harnesses/damage-control/index.ts -e .pi/harnesses/agent-hub/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
