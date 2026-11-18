---
"@chankov/agent-fleet": patch
---

Damage-Control no longer asks for permission to "modify" `/bin/` or `/usr/` when a command merely runs a program by path, such as `/opt/az/bin/python3 script.py`, `.venv/bin/python -m pytest`, or `/usr/bin/git status`. The program's own path is treated as read; its arguments stay protected, so `/opt/az/bin/tool --output /bin/x` and `/bin/rm -- README.md` still block. The fallback for commands that can't be parsed now matches absolute protected paths only where a path starts, and still catches `-t/etc/`.

An approval dialog that closes unanswered (it timed out or was dismissed) is now reported the same way whether or not a Codex permission relay is attached. The block is recorded as `blocked_prompt_timeout`, the agent is told that nobody answered (not that the user denied the call), and it is pointed at `/af-allow`. Before, the relay path returned a bare "permission cancelled, expired or stale" message that agents mistook for a harness fault.
