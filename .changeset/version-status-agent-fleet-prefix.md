---
"@chankov/agent-fleet": patch
---

The version shown by every `just fleet` harness now reads `agent fleet v<version>` instead of a bare `v<version>`, so a pi session started outside this project says whose version it is — and `agent fleet` is a clickable OSC 8 terminal hyperlink to the project homepage.

The shared status entry registered by `agent-hub`, `coms`, and `damage-control-continue` and the agent-hub footer (`agent fleet v0.0.7 · <model><thinking> · <team>`) both take the label from one `formatVersionLabel()` helper in each harness's local `version.ts`, so the two surfaces cannot drift.

The link is terminal-level, not a TUI control: pi has no mouse tracking, so a click hands the URL to the OS opener rather than opening an in-process overlay. Terminals without OSC 8 support render the label as plain text, and pi's `visibleWidth`/`truncateToWidth` strip OSC sequences, so the link costs no footer columns. Set `AGENT_FLEET_NO_LINKS=1` for a plain label on multiplexers that mangle unknown OSC sequences (GNU screen, tmux before 3.4).
