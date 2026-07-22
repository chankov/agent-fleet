---
name: peer-coms
description: Makes Claude Code a first-class peer in the local coms agent pool — discover pi colleagues, ask or delegate to them mid-task, and answer their inbound questions. Use when running inside a bridged herdr pane (a coms-claude-bridge is attached), when a task would benefit from asking a running pi peer (researcher, documenter, an orchestrator hub), or when a message prefixed "[coms message from …]" arrives.
---

# Peer Coms — talking to the local agent pool

## Overview

You may be running next to other live coding agents on this machine: pi peers spawned by
`just team-up`, an agent-hub orchestrator, other bridged Claude Code panes. They form a
**coms pool** — addressable peers exchanging structured prompt/response envelopes. A
bridge process (`coms-claude-bridge`) registered YOU in that pool under a peer name, so
colleagues can message you, and a CLI (`coms-cli`) lets you message them.

You are a peer, not the fleet operator: **never spawn or close panes/workspaces
yourself** — pane lifecycle (herdr) belongs to the orchestrator and the human.

## When to Use

- A question a *running* peer can answer better or cheaper than you — a `researcher`
  peer for codebase reconnaissance, `documenter` for docs work, the orchestrator hub for
  cross-cutting decisions.
- Delegating a bounded sub-task to a peer while you continue working.
- An inbound message arrives in your conversation prefixed `[coms message from <name> @
  <cwd>]` — a peer is asking YOU.

## Process

**Discover** who is alive (name, model, purpose):

```bash
node --experimental-strip-types scripts/coms-cli.ts list
```

**Ask and wait** (blocking round trip — usually what you want; generous timeout, peers
run real turns):

```bash
node --experimental-strip-types scripts/coms-cli.ts send researcher \
  "Where is the retry logic for outbound webhooks? file:line please" \
  --await --timeout 300000
```

**Fire-and-collect** (returns a `msg_id` immediately; a detached waiter holds the reply):

```bash
node --experimental-strip-types scripts/coms-cli.ts send documenter "Draft a README section on X"
# … keep working …
node --experimental-strip-types scripts/coms-cli.ts await <msg_id> --timeout 300000
```

**Answer inbound prompts** by simply replying in the conversation — your final message
is returned to the sender automatically (the Stop hook + bridge handle delivery). Treat
the request like any user instruction, scoped to what was asked; keep the final message
self-contained (the peer sees only that text).

## Legacy spool migration

Project-scoped CLI queues live at `~/.pi/coms/cli/projects/<project>/<name>/`.
If the CLI refuses because `~/.pi/coms/cli/<name>/` exists, stop commands for
that identity, inspect the old `pending`, `responses`, and `inbound` queues,
identify their owning project, and move the complete name directory under that
project. Never delete pending data or merge ambiguous queues just to clear the
error. `projects` is a reserved identity name.

## Common Rationalizations

- *"I'll just do it myself, asking a peer is overhead"* — a researcher peer with the
  codebase already loaded answers file:line questions cheaper than you re-deriving them.
- *"I'll spawn a helper pane for this"* — no. You are not the fleet operator; ask the
  orchestrator peer instead.
- *"The peer didn't answer, I'll retry in a loop"* — one retry after the timeout, then
  report the peer unreachable in your reply/summary.

## Red Flags

- Running `herdr pane …`, `herdr workspace …`, or any pane-spawning command yourself.
- Sending secrets or whole-file dumps through `coms-cli send` — send questions and
  bounded context, reference paths instead of contents.
- Blocking forever: every `--await`/`await` needs an explicit `--timeout`.
- Replying to an inbound prompt with your internal notes instead of a self-contained
  answer — the sender sees only your final message.

## Verification

- [ ] `coms-cli list` shows the peer before you send to it.
- [ ] Every send used `--await`/`await` with a timeout, and you handled the timeout path.
- [ ] Inbound prompts got a self-contained final message (no dangling "see above").
- [ ] You did not create or destroy any pane/workspace.
