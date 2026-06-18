---
"@chankov/agent-skills": minor
---

Add a `web-debugger` agent persona for interactive headful Chrome debugging via the `chrome-devtools-mcp` extension, plus the coms-peer plumbing to run it.

- **New persona** `agents/web-debugger.md` — drives the live `chrome_devtools__*` tools (DOM snapshot, console, network, performance traces) for runtime-UI verification with a human in the loop. It is the interactive counterpart to `bowser` (headless `playwright-cli` automation): `bowser` is delegatable to a `--no-extensions` subagent, while `web-debugger` runs as a coms peer that loads the extension. Reads the `browser-testing-with-devtools` skill. Marked pi-only.
- **Peer plumbing** — `peers.yaml` peer entries gain an optional `extensions:` field; `team-up.ts` routes such peers through a new `just _peer-plus <extensions> …` recipe that loads the named `.pi/extensions/` into the peer process alongside coms + compact-and-continue. The `web-debugger` peer is wired into the `full` and `web` teams.
