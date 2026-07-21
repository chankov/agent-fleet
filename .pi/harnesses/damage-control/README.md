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
aborted (`ctx.abort()`). For the softer variant that blocks but feeds back so the agent
adapts and keeps working, see [`damage-control-continue`](../damage-control-continue/README.md)
— the default guardrail for the `just hub` main session and spawned research helpers.

## Version footer and provenance

This persistent-UI harness shows `v<version>` below the prompt. It shares one common-key
status with `agent-hub`, `coms`, and `damage-control-continue`, so a stack renders the version
once. Its version remains separate from the mutable `damage-control` status: an active-rule or
last-violation message never replaces it. The root `package.json` is canonical;
`bin/sync-harness-versions.js` synchronizes its value into this adjacent manifest. The local
`version.ts` reader supports copied or symlinked harness directories by resolving that adjacent
stamp, but those targets still require the pre-existing full `.pi/harnesses/` dependency
installation.

## Exemptions (pre-granted only)

The hard-stop variant honors **pre-granted exemptions** from the shared exemptions
file agent-hub passes down via `AGENT_HUB_EXEMPTIONS_FILE` (written by `/allow
<pattern> session` or an approved escalation in the dispatcher session). Exemptions
apply to the path categories only — `zeroAccessPaths`, `readOnlyPaths`,
`noDeletePaths` — never to the destructive `bashToolPatterns`. There is no
prompting and no escalation here by design: a specialist run never negotiates
access mid-flight; grants happen in the hub before or between dispatches.
Agent-scoped grants (`Allow for <agent>`) only reach the child whose
`AGENT_HUB_AGENT_ID` matches.

The exemption plumbing (file I/O + escalation protocol types) lives in
[`shared.ts`](./shared.ts), used by both variants and agent-hub.

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
- Pre-granted exemptions from the hub session's shared file are honored (not in
  upstream) — see the Exemptions section above.
