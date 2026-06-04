---
"@chankov/agent-skills": minor
---

Add a `btw` always-on pi extension that adds a single `/btw <task>` prompt command, modeled on Claude Code's `/btw`. It forks the current session (a byte copy of its append-only JSONL) into a fire-and-forget background child `pi` run that inherits the full conversation as context, works the side task in the same cwd (no worktree, no isolation), and reports back as a chat card rendered expanded by default. Because pi runs extension commands before the streaming queue, `/btw` works even while the main agent is busy; results are delivered only when the session is idle (deferred to `agent_end` while streaming) so the main turn is never interrupted, and an `on("context")` filter keeps `btw-result` cards out of the main agent's LLM context. Wired into `guided-workspace-setup` (pi extensions group) and documented in `docs/pi-setup.md` and `docs/pi-extensions.md`; run artifacts live under the gitignored `.pi/btw-sessions/`.
