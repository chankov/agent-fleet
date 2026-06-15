---
"@chankov/agent-skills": minor
---

Rewrite the `btw` pi extension around an in-process sub-session and a live modal

`/btw <task>` no longer spawns a child `pi` process and waits to report back as a
single expanded chat card. It now forks the current session into an **in-process
sub-session** (`createAgentSession`, default coding tools, no extension runtime) and
opens a **top-center modal** that streams the sub-session's transcript live and
accepts follow-ups — mid-run follow-ups steer the active turn, idle ones start a fresh
turn.

- New `Alt+Shift+B` shortcut (and bare `/btw`) reopens the modal on the last-viewed thread.
- `Esc` hides the modal while the task keeps running; completion only toasts and never
  steals focus. `←/→` switches between concurrent threads; `↑/↓` scrolls; `Ctrl+C`
  copies the selected entry.
- Each finished turn writes the full answer to `.pi/btw-sessions/<id>.result.md` and
  drops a **compact** card (✓/✗ + task + elapsed + first lines + artifact path) into
  the main transcript at idle — replacing the old expanded-by-default card.

The token-thinness invariants are unchanged: command-only surface, no model-callable
tool, and the `on("context")` filter still keeps every btw card out of the main
agent's LLM context.
