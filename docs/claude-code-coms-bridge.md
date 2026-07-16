# Claude Code as a coms peer — the bridge

Makes an interactive Claude Code (terminal CLI) a **first-class, bidirectional peer** in
the local coms pool: pi agents reach it with plain `coms_send`/`coms_await`, and Claude
Code itself asks pi peers questions mid-task via `coms-cli`. Requires a running
[herdr](https://herdr.dev) server (the bridge drives the Claude pane through herdr's
socket API).

```
pi hub ── coms envelope ──▶ coms-claude-bridge ── pane.send_text ──▶ Claude Code (pane)
pi hub ◀── response ─────── coms-claude-bridge ◀── Stop hook file ─── (turn ends)
Claude Code ── Bash: coms-cli send/await ──▶ any pi peer            (outbound asks)
```

## Pieces

| Piece | File | Role |
|---|---|---|
| Bridge daemon | `scripts/coms-claude-bridge.ts` | One per Claude pane. Registers coms peer `<name>`, serializes inbound prompts, types them into the pane (+ Enter separately — TUI quirk), captures the reply, sends the response envelope. |
| Envelope CLI | `scripts/coms-cli.ts` | `list` / `send` / `await` / `reply` — any process becomes a coms participant. `send --await` is a blocking round trip; plain `send` prints a `msg_id` and a detached waiter holds the reply for `await`. |
| Stop hook | `hooks/coms-stop-hook.mjs` | PRIMARY completion path: writes each turn's final assistant message to `~/.pi/coms/claude-bridge/<pane>/last-message.json` (keyed by `HERDR_PANE_ID`). Exact text, no scraping. |
| Skill | `skills/peer-coms/SKILL.md` | Teaches Claude Code its peer role: discover with `coms-cli list`, ask with `send --await`, answer inbound prompts normally, never drive panes itself. |
| Runner | `runner: claude-code` in `.pi/agents/peers.yaml` | `just team-up` spawns the Claude CLI + its bridge in one pane (`_claude-peer` recipe); `model:` maps to `claude --model`, team-resume maps the herdr-captured session id to `claude --resume`. |

## Setup

1. **Hook (recommended):** add to the project's (or user's) Claude Code `settings.json`:

   ```json
   {
     "hooks": {
       "Stop": [{ "hooks": [{ "type": "command",
         "command": "node /path/to/agent-fleet/hooks/coms-stop-hook.mjs" }] }]
     }
   }
   ```

   Without the hook the bridge falls back to asking Claude for a
   `<<COMS_DONE:msg_id>>` sentinel and scraping the pane — it works, but replies can
   carry TUI noise (tool-status lines). The hook returns exact text.

2. **Skill:** install `peer-coms` via the normal per-agent flow so Claude Code knows it
   is a peer and how to use `coms-cli`.

3. **Spawn:** either add a `runner: claude-code` peer to a peers.yaml team and
   `just team-up <team>`, or attach a bridge to an existing herdr Claude pane:

   ```bash
   node --experimental-strip-types scripts/coms-claude-bridge.ts --name claude-main
   # (inside the pane: HERDR_PANE_ID is inherited; or pass --pane <id>)
   ```

## Demo scenario (verified live)

```bash
just team-up docs                      # pi peers up
# pane with: bridge (claude-main) + claude
just hub                               # in another pane: the orchestrator
# from the hub (or any shell):
node --experimental-strip-types scripts/coms-cli.ts send claude-main \
  "Summarize the failing test output in artifacts/test.log" --await --timeout 300000
```

And the reverse — Claude Code, mid-task, asking a pi peer:

```bash
node --experimental-strip-types scripts/coms-cli.ts send researcher \
  "Where is the retry logic for webhooks? file:line" --await --timeout 300000
```

## Serving team dispatches (coms-backed dispatch)

A bridge peer that shares a name with an agent-hub team member (e.g. `code-reviewer`,
`plan-reviewer` in the shipped `peers.yaml`) can serve that member's `dispatch_agent`
calls transparently: `.pi/agents/dispatch-policy.yaml` marks the member `prefer: coms`,
and the hub routes the dispatch to the live peer instead of spawning a native subagent —
same return contract, ASK_USER handling, and history. The standing Claude session keeps
its context across review rounds, which is the point for code/plan review. See
"Coms-backed dispatch" in `.pi/harnesses/agent-hub/README.md`.

## Behavior notes

- **Serialization:** one prompt at a time per pane; queue depth shows in the peer's
  agent card and the herdr sidebar (`<name> q<depth>`).
- **Blocked panes:** a Claude waiting on a permission prompt returns a readable error
  envelope ("blocked on a permission prompt — a human must approve it") instead of
  hanging until timeout.
- **Busy panes:** a prompt arriving while Claude is mid-turn errors immediately
  ("mid-turn — try again shortly") rather than typing into a running turn.
- **Restarts:** the bridge is bound to the pane id, not the Claude process — restart
  Claude in the pane and the bridge keeps working.
- **Fleet safety:** the bridge and skill never create or close panes; herdr driving
  stays with the orchestrator (see `.pi/damage-control-rules.yaml`).
