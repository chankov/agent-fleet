---
"@chankov/agent-skills": patch
---

Document the division between the two pi browser stacks and align the orchestrator's runtime-UI guidance.

- New "Two browser stacks — when to use which" decision section in `docs/pi-extensions.md` (policy + why `web-debugger` is a coms peer, not a subagent).
- The `orchestrator` persona now routes `runtime-ui` proof by mode: delegate a `bowser` subagent for headless evidence, or hand off to the `web-debugger` coms peer for interactive headful Chrome.
- Cross-reference notes added between `.pi/skills/bowser/SKILL.md`, `skills/browser-testing-with-devtools/SKILL.md`, and the `chrome-devtools-mcp` extension README.
