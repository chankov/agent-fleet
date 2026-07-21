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

By default both variants hard-block. The choice is whether the agent's turn dies
or keeps going — plus, in this variant, whether **you** let the call through via
exemptions (below).

## Version footer and provenance

This persistent-UI harness shows `v<version>` below the prompt. It shares one common-key
status with `agent-hub`, `coms`, and `damage-control`, so a stack renders the version once. Its
version remains separate from the mutable `damage-control` status: active-rule and
last-violation feedback never replaces it. The root `package.json` is canonical;
`bin/sync-harness-versions.js` synchronizes its value into this adjacent manifest. The local
`version.ts` reader supports copied or symlinked harness directories by resolving that adjacent
stamp, but those targets still require the pre-existing full `.pi/harnesses/` dependency
installation.

## Exemptions — allow access per turn or per session

Runtime allowances layered on top of the rules file (which is never modified).
They apply to the **path categories only** — `zeroAccessPaths`, `readOnlyPaths`,
`noDeletePaths`. Destructive `bashToolPatterns` (`rm -rf`, `git push --force`,
`DROP TABLE`, …) can never be exempted.

**Pre-authorize** (when you know the agent will need it):

```
/allow .env            # exempt for the rest of the session (default)
/allow .env turn       # exempt until the end of the current/next turn
/allowed               # list active exemptions
/revoke .env           # remove an exemption
```

**Block-time dialog** (when you forgot): in an interactive session a path block
opens a selector — *Keep blocked / Allow once / Allow for this turn / Allow for
this session*. An approved call proceeds immediately (the agent never sees the
block); *Keep blocked* is remembered for the rest of the turn so the agent can't
re-prompt you; no answer within 60s fails closed.

**Escalation from headless children**: when this harness runs inside a subagent
spawned by agent-hub (no UI, `AGENT_HUB_ASK_ENDPOINT` set), a path block sends an
`access_request` to the hub's coms socket instead. The dispatcher session shows
who is asking, for what, and why it was blocked — *Deny / Allow once / Allow for
this agent / Allow for all agents (session)*. The child waits up to 60s and fails
closed on timeout; a late answer still lands in the shared exemptions file, so
the next attempt (from any child) passes. At most 3 escalations per child run;
denials are cached.

**Shared exemptions file**: agent-hub keeps one session-scoped file
(`~/.pi/coms/exemptions/<session>.json`, deleted on shutdown) and passes it to
every spawned child via `AGENT_HUB_EXEMPTIONS_FILE`. `/allow <pattern> session`
in the hub lands there, so it covers the whole team — including hard-stop
[`damage-control`](../damage-control/README.md) specialists, which honor the
file but never prompt or escalate. It is re-read on every block, so mid-session
grants reach already-running children. Everything (grants, revokes, escalation
outcomes) is logged to the `damage-control-log` session entries.

## When it's used (this repo)

`just hub` / `just hub-solo` load this variant for the **orchestrator/dispatcher
main session**, and the hub re-loads it into spawned **research helpers**
(`researcher` / `deep-researcher`) — both need to recover from a blocked read and
keep going rather than abort. Every other spawned specialist (builder,
test-engineer, …) keeps the hard-stop `damage-control` harness.

## Commands & tools

- `/allow <pattern> [turn|session]` — exempt a protected path pattern
- `/allowed` — list active exemptions
- `/revoke <pattern>` — remove an exemption

Blocking itself runs passively on the `tool_call` event.

## Requires

- `.pi/damage-control-rules.yaml` — the rule set (shipped in this repo)
- Optional, injected by agent-hub into spawned children: `AGENT_HUB_ASK_ENDPOINT`
  (escalation socket), `AGENT_HUB_EXEMPTIONS_FILE` (shared grants),
  `AGENT_HUB_AGENT_ID` (requester identity). Without them the harness behaves
  standalone: dialog when a UI is present, plain block+feedback otherwise.

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
- Exemption layer added (not in upstream): `/allow`/`/allowed`/`/revoke`,
  block-time approval dialog, and escalation from headless agent-hub children to
  the dispatcher — see the Exemptions section above. Shared plumbing lives in
  [`../damage-control/shared.ts`](../damage-control/shared.ts).
