# compact-and-continue

A pi extension that registers a single tool, `request_compaction`, for queueing pi context compaction at a safe checkpoint and (optionally) resuming work from a self-contained continuation prompt afterward.

## What it does

`request_compaction` does **not** compact immediately. It queues the request, lets the current agent turn finish, then runs compaction on `agent_end`. If a `continuationPrompt` is provided, the extension re-injects it as a new user message after compaction finishes — pi picks up exactly where the summarized plan says to continue.

This keeps the user in control: compaction never interrupts a tool call mid-flight, and resumption is explicit (you decide what survives the compaction by what you put in `continuationPrompt`).

## Tool: `request_compaction`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `customInstructions` | string | no | Instructions for the compaction summary. Defaults to: *"Preserve task goal, completed work, changed/read files, decisions, blockers, and next steps."* |
| `reason` | string | no | Short explanation recorded in tool details. |
| `continuationPrompt` | string | no | Self-contained summary of the remaining plan. If provided, pi auto-resumes from this message after compaction. **Do not copy the original prompt verbatim** — restate the next concrete actions. |

The tool does not ask for confirmation. Workflows that need confirmation (e.g. `/af-build`) must ask the user **before** calling it.

## When to use

Use only when explicitly requested by the user, a skill, or a prompt template. Do not call it pre-emptively or on a hunch that context is "getting long" — pi has its own autocompaction for that.

The canonical usage point in this repo is `/af-build`: at slice-approval time, the user can pick "Compact & continue" to compact between slices and resume from a summarized remaining plan. See `.pi/prompts/af-build.md` and `skills/incremental-implementation/SKILL.md`.

## Install

Installs alongside the other extensions (see [docs/pi-setup.md](../../../docs/pi-setup.md#optional-pi-extensions)):

```bash
npx @chankov/agent-fleet install --agent pi --items pi-extension:compact-and-continue --yes
```

It also comes in with the `pi-fleet-core` profile. The only runtime dep (`typebox`) is declared in `.pi/extensions/package.json` alongside the other extensions, so no extra `npm ci` is needed if you have already installed those.

## Behavior notes

- Multiple queued requests in the same turn are coalesced into one compaction with all reasons concatenated.
- Only the latest `continuationPrompt` (last queued) is honored.
- If compaction fails, the error is surfaced via `ctx.ui.notify` and the queue is drained — pi does not auto-retry.
- The tool returns `terminate: true`, ending the current turn so `agent_end` can fire and the queued compaction can run.
