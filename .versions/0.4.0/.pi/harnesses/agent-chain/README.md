# agent-chain

Sequential pipeline orchestrator.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Runs opinionated, repeatable agent workflows. Chains are sequences of agent steps with
prompt templates: the user's prompt flows into step 1, that output becomes `$INPUT` for
step 2's template, and so on. `$ORIGINAL` always holds the user's original prompt.

The primary pi agent has **no codebase tools** — it can only kick off a pipeline via the
`run_chain` tool. On boot you select a chain; the agent decides when to run it. Agents
keep their session context within a pi session, so re-running a chain resumes each step.

## Commands & tools

- `/chain` — switch the active chain
- `/chain-list` — list all available chains
- `run_chain` tool — the only tool the primary agent has

## Requires

- `.pi/agents/agent-chain.yaml` — chain definitions
- `.pi/agents/*.md` — the agent personas referenced by each chain step

## Usage

```bash
pi -e .pi/harnesses/agent-chain/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
