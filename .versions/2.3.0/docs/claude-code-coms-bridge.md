# Claude Code as a coms peer — the bridge

Makes an interactive Claude Code (terminal CLI) a **first-class, bidirectional peer** in
the local coms pool: pi agents reach it with plain `coms_send`/`coms_await`, and Claude
Code itself asks pi peers questions mid-task via `coms-cli`. Requires a running
[herdr](https://herdr.dev) server (the bridge drives the Claude pane through herdr's
socket API).

Hub dispatches to the `reviewer` role (including parallel instances such as `reviewer--p2`) opt into review protocol v1. Progress does not complete the request. On both Claude and Pi peers, put prose inside the report, not before or after the frame (embedded examples are not final). To finish, return a standalone JSON object, optionally enclosed in a single JSON code fence, with the original `msg_id`, `phase: "final"`, `verdict: "APPROVE"` or `"REJECT"`, and a nonempty `report` string. If the wait times out, use `coms_get` or `coms_await` with that same ID; do not send a second review request. Ordinary messages still accept a plain-text reply.

When a Pi reviewer ends a turn with an incomplete frame, the receiving peer requests the final frame once on the same message ID. The follow-up respects the normal queue pause. A second incomplete reply ends the review with an error and releases the next queued request.

A terminal row break with a hanging indent can split a word or replace a space. If it falls inside the report, the Claude bridge waits for the exact Stop hook text until the reply deadline. If only the ambiguous final frame is available then, the sender receives a transcription error.

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
| Bridge daemon | `.pi/agent-fleet/scripts/coms-claude-bridge.ts` | One per Claude pane. Registers coms peer `<name>`, serializes inbound prompts, types them into the pane (+ Enter separately — TUI quirk), captures the reply, sends the response envelope. |
| Envelope CLI | `.pi/agent-fleet/scripts/coms-cli.ts` | `list` / `send` / `await` / `reply` — any process becomes a coms participant. `send --await` is a blocking round trip; plain `send` prints a `msg_id` and a detached waiter holds the reply for `await`. |
| Stop hook | `.pi/agent-fleet/hooks/coms-stop-hook.mjs` | PRIMARY completion path: writes each turn's final assistant message to `~/.pi/coms/claude-bridge/<pane>/last-message.json` (keyed by `HERDR_PANE_ID`). Exact text, no scraping. The text comes from the hook input's `last_assistant_message`; Claude Code can run the hook before its transcript holds the final message, so the transcript is only a fallback for older versions, and there the hook waits up to 2 s for the current turn's finished message and otherwise writes nothing. It never answers with an earlier turn's reply. |
| Skill | `skills/peer-coms/SKILL.md` | Teaches Claude Code its peer role: discover with `coms-cli list`, ask with `send --await`, answer inbound prompts normally, never drive panes itself. |
| Runner | `just fleet peer <name> --runner claude-code` | Spawns the Claude CLI + its bridge in one pane (`_claude-peer` internally); `--model` maps to `claude --model`. The Hub's `herdr_spawn_peer` with `runner: "claude-code"` does the same from inside Herdr. |

## Setup

The stable `claude-bridge` setup feature selects `peer-coms` and its
`coms-stop-hook` companion. Use `agent-fleet setup --preset default --features
claude-bridge --yes` (or select it interactively); it puts both halves in place:
`.pi/skills/peer-coms/` and `.pi/agent-fleet/hooks/coms-stop-hook.mjs`. The hook ships with
the rest of the fleet runtime; Claude Code reaches it through `.claude/settings.json`,
which is the one place it looks for hooks.

**Registering the hook stays a manual step.** The installer writes the file; it does not
touch `.claude/settings.json`, because that file is the user's own Claude Code
configuration and merging into it is not something a pi install should decide.

1. **Hook (recommended):** add to the project's (or user's) Claude Code `settings.json`:

   ```json
   {
     "hooks": {
       "Stop": [{ "hooks": [{ "type": "command",
         "command": "node $CLAUDE_PROJECT_DIR/.pi/agent-fleet/hooks/coms-stop-hook.mjs" }] }]
     }
   }
   ```

   Without the hook the bridge falls back to asking Claude for a
   `<<COMS_DONE:msg_id>>` sentinel and scraping the pane. Fallback extraction requires
   a unique current-request boundary (message ID plus per-submission nonce), a nonempty
   reply after that boundary, and an exact terminal current-ID marker. Prompt echoes,
   stale/foreign markers, missing or ambiguous boundaries and truncated captures do
   not prove completion. Replies can still carry TUI noise; the hook returns exact text.

2. **Skill:** install `peer-coms` so the bridged session knows it is a peer and how to
   use `coms-cli`. Point Claude Code at it the way you normally load project skills —
   a `CLAUDE.md` reference to `.pi/skills/peer-coms/SKILL.md` is enough.

3. **Spawn:** start the peer on its own with `just fleet peer <name> --runner claude-code`
   (add `--read-only` for a reviewer or researcher peer), call `herdr_spawn_peer` from a Hub
   running inside Herdr, or attach a bridge to an existing Herdr Claude pane:

   ```bash
   just fleet peer claude-reviewer --runner claude-code --read-only --project af
   node --experimental-strip-types .pi/agent-fleet/scripts/coms-claude-bridge.ts --name claude-main
   # (inside the pane: HERDR_PANE_ID is inherited; or pass --pane <id>)
   ```

## Demo scenario

```bash
just fleet peer researcher --read-only                # a read-only Pi peer
just fleet peer claude-main --runner claude-code      # pane with: bridge (claude-main) + claude
just fleet                                            # in another pane: the Hub
# from the hub (or any shell):
node --experimental-strip-types .pi/agent-fleet/scripts/coms-cli.ts send claude-main \
  "Summarize the failing test output in artifacts/test.log" --await --timeout 300000
```

And the reverse — Claude Code, mid-task, asking a pi peer:

```bash
node --experimental-strip-types .pi/agent-fleet/scripts/coms-cli.ts send researcher \
  "Where is the retry logic for webhooks? file:line" --await --timeout 300000
```

## Serving a role (coms-backed dispatch)

A bridge peer can serve a role's `dispatch_agent` calls transparently.
`.pi/agents/dispatch-policy.yaml` keys each route by role and names the peer address
separately; the shipped policy sends reviews to a Claude Code peer:

```yaml
routes:
  reviewer:
    peer: claude-reviewer
    prefer: coms
    fallback: native
```

The Hub then routes a `reviewer` dispatch (and its parallel instances) to the live
`claude-reviewer` instead of spawning a native subagent — same return contract,
ASK_USER handling, and history. The standing Claude session keeps its context across
review rounds. A read-only role reaches only a peer started with `--read-only` (see
below), and such a peer takes no writer slot, so it can review beside an active editor.
A reviewer route never reaches a peer address that changed a file in the review's scope,
even after the peer restarts: a peer is its address, whatever its session. An `auto`
route then runs a native reviewer with a notice; an explicit `backend: "coms"` or
`fallback: none` is refused before anything starts. For a deliberately fresh reviewer,
start a peer under another name. See [peers serving a role](agents.md#peers-serving-a-role)
and "Coms-backed dispatch" in `.pi/harnesses/agent-hub/README.md`.

## Read-only peers

A peer normally runs with its own full tools; the Hub only sends it a prompt.
Researcher and reviewer roles may use a peer only when it declares
`read_only: true` in its coms registry entry
(`~/.pi/coms/projects/<project>/agents/<name>.json`, the entries
`peersInScope()` returns). Peers without the field behave as before.

Request it with `just fleet peer <name> --read-only` (or `read_only: true` on
`herdr_spawn_peer`). The launch enforces the restriction and the peer declares it
only from evidence it checks itself:

| Runner | Launch | Declared when |
|---|---|---|
| `claude-code` | `_claude-peer-read-only`: the bridge runs in the foreground and starts `claude --tools Read,Grep,Glob --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch --strict-mcp-config --permission-mode dontAsk` itself | the bridge spawned exactly that argv; it deregisters when that Claude exits |
| pi persona | `_peer-read-only`: pi `--tools read,grep,find,ls --no-mcp --coms-read-only` | coms sees a plain `--tools` allowlist inside `read,grep,find,ls`, and every registered and active tool is inside it |

`--strict-mcp-config` is required: `--tools` alone keeps every MCP tool
(plugins and claude.ai connectors). With all four flags, Claude Code 2.1.330
reports exactly `Glob`, `Grep`, `Read` and no MCP servers. pi drops every
tool outside a `--tools` allowlist from its registry, so the set cannot grow
later in the session. When the pi check fails, the peer registers **without**
`read_only` and shows a warning. The Hub then runs the role natively. A
read-only pi peer loads no extension, not even `chrome-devtools-mcp`, and needs
a role or persona file (`--persona`) to launch.

Neither runner can message other peers: the pi peer has no `coms_*` tools
and the Claude pane has no Bash for `coms-cli`. A read-only peer therefore
cannot ask a writable peer to act for it, like a native read-only child. It
still answers inbound requests, because the coms runtime sends the reply
when the turn ends; the Claude bridge reads it from the pane or Stop hook.
The guarantee covers the model's tools; a human at the pane can still start
another process.

## Migrating legacy CLI spools

Current releases isolate CLI queues by project at:

```text
~/.pi/coms/cli/projects/<project>/<name>/
```

Older releases used the ambiguous name-only path `~/.pi/coms/cli/<name>/`. If that legacy directory exists, `send`, `await`, `reply`, and listener operations fail closed rather than assigning queued messages to whichever project runs first. Before upgrading, stop commands using that CLI identity, inspect its `pending`, `responses`, and `inbound` files, determine the owning project, and move the complete `<name>` directory to `cli/projects/<project>/<name>`. Do not merge two queues or delete pending data merely to clear the error. The name `projects` is reserved for the namespace and cannot be used as a coms identity.

## Behavior notes

- **Executable preflight:** a standalone `fleet peer` requires `claude --version`
  to succeed before it creates a pane, so a missing CLI or partial npm install
  fails directly instead of surfacing as a 45-second registration timeout. Panes
  from `herdr_spawn_peer` and direct `_claude-peer` calls repeat the check inside
  the pane before starting its bridge; their failure remains visible in that pane.
- **Serialization:** one prompt at a time per pane; queue depth shows in the peer's
  agent card and the herdr sidebar (`q<depth>`).
- **Presence:** the bridge annotates its pane through the shared `HerdrPresence`
  (same dialect negotiation as pi peers — `tokens` on herdr >= 0.7.4, one latched
  fallback to `custom_status`), so the pane carries `coms`/`proj` and the fleet panel
  can join it to the registry entry. It writes the annotation ONLY, never
  `pane.report_agent`: the pane's `agent_status` is herdr's own Claude detection and
  the bridge polls it back as its turn-completion signal.
- A permission prompt before submission can refuse the dispatch. After submission, a
  permission prompt leaves the dispatch pending while the human answers in the peer pane.
  The Hub holds the writer slot until the peer returns a terminal reply.
- **Busy panes:** the bridge waits with bounded backoff before submitting; exhausting
  that wait returns a mid-turn error without typing the prompt. One absolute reply
  deadline covers both idle waiting and the reply, rather than extending the budget.
- **Pending versus completion:** after submission, exceeding the reply budget leaves
  the original message pending. The bridge watches the same turn up to its hard
  monitoring cap; a valid late reply resolves the original `msg_id` without resubmission.
  At the cap it remains pending, not a fabricated successful or no-effects response.
  Working→idle/done alone is insufficient: fallback also requires current reply provenance.
- **Hook freshness:** hook mode is latched once observed. The bridge snapshots hook
  mtime immediately before submission (after any busy wait) and ignores unchanged or
  malformed records. A newer valid record supports completion, but mtime is not
  authenticated request identity: unrelated fresh hook traffic remains indistinguishable.
- **Restarts:** the bridge is bound to the pane id, not the Claude process — restart
  Claude in the pane and the bridge keeps working.
- **Fleet safety:** the bridge and skill never create or close panes; herdr driving
  stays with the Hub (see `.pi/damage-control-rules.yaml`).
