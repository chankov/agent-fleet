# btw

A pi extension that adds a single prompt command, `/btw`, plus an `Alt+Shift+B`
shortcut, for spinning off a **side task** that inherits the full context of the
current session and streams into a live modal — modeled on Claude Code's `/btw`.

## What it does

`/btw <task>` forks the current session into an **in-process sub-session** and
opens a modal over it:

1. **Forks the session** — `SessionManager.forkFrom` writes the current
   append-only JSONL into `.pi/btw-sessions/<...>.jsonl`. The sub-session starts with
   the *entire* conversation as context. The main session file is never touched.
2. **Runs in-process** — the fork is wrapped in a real `AgentSession`
   (`createAgentSession`) with the fixed default built-in tools (`read, bash, edit,
   write`) and **no extensions** loaded. It does not inherit the parent session's
   active tool selection or custom tools. It is *not* a child `pi` process — there is
   no spawn, no JSON-stream parsing, no SIGTERM. It works in the same cwd as the main
   session.
3. **Opens a live modal** — a top-center overlay shows the sub-session's transcript
   as it streams (assistant text, tool calls, thinking), with a footer composer for
   follow-ups. The modal is the primary surface.
4. **Drops a compact card at idle** — when a turn finishes, the full answer is
   written to `.pi/btw-sessions/<id>.result.md` and a **compact** card (✓/✗ + task +
   elapsed + the first few lines + the artifact path) is queued for the main
   transcript, delivered only when the main session is idle.

## Command & shortcut

- **`/btw <task>`** — start a side task and open its modal.
- **`/btw`** (no args) — reopen the modal on the last-viewed (or most recent) thread.
- **`Alt+Shift+B`** — reopen the modal. (Plain `Alt+B` is reserved by pi for the
  editor's cursor-word-left.)

### Modal keys

- **Type + Enter** — send a follow-up. Mid-run it *steers* the active turn; when the
  task is idle it starts a fresh turn.
- **Esc** — hide the modal. The task keeps running; you are returned to the main
  session. Reopen with `Alt+Shift+B` or `/btw`.
- **↑ / ↓** — scroll the transcript (the selected entry expands; tail-follows the
  newest until you scroll up).
- **← / →** — switch between concurrent threads (when more than one is running).
- **Ctrl+C** — copy the selected transcript entry.

`/btw` and `Alt+Shift+B` are the entire surface — no model-callable tool, no subcommands.
The agent cannot trigger it; only you can.

## Design constraints (intentional)

- **In-process, not a child process.** The side task is a real `AgentSession` forked
  from the current one, running in the same process. This is what lets the modal show
  a live transcript and accept follow-ups while the main session is mid-turn — the
  old child-`pi` model could only report back as a card once it finished.
- **No extension runtime in the sub-session.** `createAgentSession` is given a
  resource loader with `noExtensions: true`, so the fork never loads (or re-runs) this
  or any other extension. No recursion, no double-bound MCP servers — the same
  guarantee the old `--no-extensions` child gave.
- **Available even while the main agent is streaming.** pi executes extension
  commands immediately in `prompt()`, *before* the streaming queue, so `/btw` never
  waits for the current turn to finish, and the modal opens right away.
- **Never steals the main session's focus.** The modal is a non-capturing overlay
  that you focus on open and release on `Esc`. Task completion only fires a toast — it
  never grabs focus or interrupts the main turn.
- **The chat card stays out of the main agent's LLM context.** An `on("context")`
  filter strips `btw-result` cards from every LLM call. The card stays visible to you;
  the main agent never ingests it. The whole extension is UI/process code — it adds
  zero tokens to the main agent.

## Install

Auto-discovered like the other always-on utilities — drop or symlink it under
`.pi/extensions/` (see [docs/pi-setup.md](../../../docs/pi-setup.md)):

```bash
ln -s /path/to/agent-skills/.pi/extensions/btw .pi/extensions/btw
```

No extra dependencies — the extension uses only Node built-ins and the pi runtime
packages, so no additional `npm install` is needed.

## Behavior notes

- **Artifacts** for each run live in `.pi/btw-sessions/` (gitignored): the forked
  `<...>.jsonl` is the sub-session's context; `<id>.result.md` is the latest final
  answer and includes the session file path. Files older than 7 days are pruned on
  `session_start`; terminal thread history in the modal is retained only for the 12
  newest terminal threads.
- **Model.** The sub-session runs with the main session's current model and inherits
  its thinking level from the forked history.
- **Follow-ups.** Each idle follow-up is its own turn and produces its own card; a
  mid-run follow-up steers the active turn and folds into that turn's single card.
- **Transcript bounds.** Modal history is capped at 200 entries and 12,000 characters
  per entry; the expanded selected entry is capped at 20,000 characters with a visible
  truncation marker. The compact chat card remains a short preview, while
  `<id>.result.md` keeps the full final assistant output for the turn.
- **Failures.** A failed turn produces an error card (with the error text) and an
  `error` toast; the transcript shows the error inline.
- **Shutdown.** Running threads are `abort()`ed when the main pi session shuts down —
  side tasks do not outlive their parent.
- **Concurrency.** Multiple `/btw` runs can be in flight at once; the footer shows
  `btw: N running` and `← / →` switches the modal between them.
- **Shared process group.** In-process bash from a side task competes with the main
  session for CPU — heavy side tasks will be felt by the main turn.

## Focused smoke checklist

- Start `/btw <task>`, confirm the modal opens immediately and elapsed time counts the current turn.
- Send a mid-run follow-up, confirm it steers the same turn and produces only one card.
- After completion, send an idle follow-up, confirm elapsed time resets and a new card is produced.
- Complete more than 12 side-task threads, confirm only terminal history is evicted and running threads remain.
- Open a long transcript entry, confirm modal truncation is marked and the `.result.md` file keeps the full final output.
