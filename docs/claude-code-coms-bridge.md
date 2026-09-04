# Claude Code as a coms peer — the bridge

Makes an interactive Claude Code (terminal CLI) a **first-class, bidirectional peer** in
the local coms pool: pi agents reach it with plain `coms_send`/`coms_await`, and Claude
Code itself asks pi peers questions mid-task via `coms-cli`. Requires a running
[herdr](https://herdr.dev) server (the bridge drives the Claude pane through herdr's
socket API).

> **This is the only role Claude Code has in Agent Fleet.** It is not a coding-agent
> install target: deterministic `agent-fleet setup` targets pi and nothing else, there are no
> `.claude/` skills, commands, or personas, and no Claude Code plugin. What a bridged
> pane gets is what this page describes — the `peer-coms` skill and the Stop hook,
> both installed under the pi agent because the *fleet* is what needs them. A Claude
> Code peer contributes review, research, and analysis turns over coms; it does not run
> the lifecycle commands or orchestrate anything.

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
| Runner | `runner: claude-code` in `.pi/agents/peers.yaml` | `just fleet team` spawns the Claude CLI + its bridge in one pane (`_claude-peer` internally); `model:` maps to `claude --model`, and `just fleet resume` maps the Herdr-captured session id to `claude --resume`. |

## Setup

The stable `claude-bridge` setup feature selects `peer-coms` and its
`coms-stop-hook` companion. Use `agent-fleet setup --preset default --features
claude-bridge --yes` (or select it interactively); it puts both halves in place:
`.pi/skills/peer-coms/` and `.claude/hooks/coms-stop-hook.mjs`. The hook file lands under
`.claude/` deliberately — that is where the Claude Code process in the pane looks for it.

**Registering the hook stays a manual step.** The installer writes the file; it does not
touch `.claude/settings.json`, because that file is the user's own Claude Code
configuration and merging into it is not something a pi install should decide.

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

2. **Skill:** install `peer-coms` so the bridged session knows it is a peer and how to
   use `coms-cli`. Point Claude Code at it the way you normally load project skills —
   a `CLAUDE.md` reference to `.pi/skills/peer-coms/SKILL.md` is enough.

3. **Spawn:** either add a `runner: claude-code` peer to a peers.yaml team and
   `just fleet team <team> --no-hub`, or attach a bridge to an existing Herdr Claude pane:

   ```bash
   node --experimental-strip-types scripts/coms-claude-bridge.ts --name claude-main
   # (inside the pane: HERDR_PANE_ID is inherited; or pass --pane <id>)
   ```

## Demo scenario (verified live)

```bash
just fleet team docs --no-hub         # Pi peers up
# pane with: bridge (claude-main) + claude
just fleet hub                         # in another pane: the orchestrator
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

## Migrating legacy CLI spools

Current releases isolate CLI queues by project at:

```text
~/.pi/coms/cli/projects/<project>/<name>/
```

Older releases used the ambiguous name-only path `~/.pi/coms/cli/<name>/`. If that legacy directory exists, `send`, `await`, `reply`, and listener operations fail closed rather than assigning queued messages to whichever project runs first. Before upgrading, stop commands using that CLI identity, inspect its `pending`, `responses`, and `inbound` files, determine the owning project, and move the complete `<name>` directory to `cli/projects/<project>/<name>`. Do not merge two queues or delete pending data merely to clear the error. The name `projects` is reserved for the namespace and cannot be used as a coms identity.

## Behavior notes

- **Executable preflight:** a standalone `fleet peer` requires `claude --version`
  to succeed before it creates a pane, so a missing CLI or partial npm install
  fails directly instead of surfacing as a 45-second registration timeout. Team
  layouts and direct `_claude-peer` calls repeat the check inside each created
  pane before starting its bridge; their failure remains visible in that pane.
- **Serialization:** one prompt at a time per pane; queue depth shows in the peer's
  agent card and the herdr sidebar (`q<depth>`).
- **Presence:** the bridge annotates its pane through the shared `HerdrPresence`
  (same dialect negotiation as pi peers — `tokens` on herdr >= 0.7.4, one latched
  fallback to `custom_status`), so the pane carries `coms`/`proj` and the fleet panel
  can join it to the registry entry. It writes the annotation ONLY, never
  `pane.report_agent`: the pane's `agent_status` is herdr's own Claude detection and
  the bridge polls it back as its turn-completion signal.
- **Blocked panes:** a Claude waiting on a permission prompt returns a readable error
  envelope ("blocked on a permission prompt — a human must approve it") instead of
  hanging until timeout.
- **Busy panes:** a prompt arriving while Claude is mid-turn errors immediately
  ("mid-turn — try again shortly") rather than typing into a running turn.
- **Restarts:** the bridge is bound to the pane id, not the Claude process — restart
  Claude in the pane and the bridge keeps working.
- **Fleet safety:** the bridge and skill never create or close panes; herdr driving
  stays with the orchestrator (see `.pi/damage-control-rules.yaml`).
