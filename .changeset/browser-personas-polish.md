---
"@chankov/agent-skills": patch
---

Polish the browser-persona division:

- `test-engineer` now states it owns test *code* and hands off live-browser runtime-UI proof to `bowser` (headless) or `web-debugger` (interactive).
- `bowser` gains an explicit `tools: read,bash` whitelist (it only needs Bash for `playwright-cli` plus read for outputs).
- `guided-workspace-setup` notes that `bowser` and `chrome-devtools-mcp` are two complementary browser stacks and recommends both for full coverage.
