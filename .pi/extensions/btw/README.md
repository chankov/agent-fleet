# btw

A pi extension that adds a single prompt command, `/btw`, for spinning off a
fire-and-forget **side task** that inherits the full context of the current
session — modeled on Claude Code's `/btw`.

## What it does

`/btw <task>` forks the current session and hands the side task to a background
child `pi` process:

1. **Forks the session** — byte-copies the current append-only JSONL session file
   into `.pi/btw-sessions/<id>.jsonl`. The child resumes from that copy (`pi -c`),
   so it starts with the *entire* conversation as context. The main session file
   is never touched.
2. **Runs in the background** — the child runs `pi --mode json -p` in the same
   working directory (no worktree, no isolation). The command returns immediately;
   the main agent keeps going.
3. **Reports back as a chat card** — when the child finishes, its final summary is
   injected as a `btw-result` message, rendered **expanded by default** so the
   answer is visible in full without any keypress. The result also persists in the
   transcript and is written to `.pi/btw-sessions/<id>.result.md`.

## Command: `/btw <task>`

`<task>` is a free-text instruction for the side task. It runs with the full
session as context and unattended, so the child makes reasonable assumptions and
proceeds on its own.

`/btw` is the entire surface — no model-callable tool, no subcommands. The agent
cannot trigger it; only you can, from the prompt.

## Design constraints (intentional)

- **Available even while the main agent is streaming.** pi executes extension
  commands immediately in `prompt()`, *before* the streaming queue, so `/btw`
  never waits for the current turn to finish.
- **Never interrupts the main session.** The result card is delivered only when the
  session is idle. If a child finishes mid-stream, delivery is deferred to the next
  `agent_end` — it never steers or follow-ups the active turn. (A `notify` toast
  tells you the moment it finishes regardless.)
- **Full context, isolated writes.** The child sees the whole history but writes to
  its *own* session copy, so its work never pollutes the main transcript or the
  main agent's reasoning.
- **Kept out of the main agent's LLM context.** An `on("context")` filter strips
  `btw-result` messages from every LLM call. The card stays visible to you; the
  main agent does not ingest it.

## Install

Auto-discovered like the other always-on utilities — drop or symlink it under
`.pi/extensions/` (see [docs/pi-setup.md](../../../docs/pi-setup.md#optional-pi-extensions)):

```bash
ln -s /path/to/agent-skills/.pi/extensions/btw .pi/extensions/btw
```

No extra dependencies — the extension uses only Node built-ins and the pi runtime
packages, so no additional `npm install` is needed.

## Behavior notes

- **Artifacts** for each run live in `.pi/btw-sessions/<id>.{jsonl,result.md,log}`
  (gitignored). The session copy is the child's context; `result.md` is the final
  answer; `log` records tool calls and any stderr. Files older than 7 days are
  pruned on `session_start`.
- **Model.** The child runs with the same model as the main session when one is
  active; otherwise it falls back to pi's default.
- **Failures.** A non-zero child exit produces an error card with the stderr tail
  instead of a result, and an `error` toast.
- **Shutdown.** Live children are sent `SIGTERM` when the main pi session shuts
  down — side tasks do not outlive their parent.
- **Concurrency.** Multiple `/btw` runs can be in flight at once; the footer shows
  `btw: N running`.
