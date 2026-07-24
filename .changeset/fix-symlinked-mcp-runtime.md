---
"@chankov/agent-fleet": patch
---

Hoist MCP extension runtime dependencies into the published package so symlinked `chrome-devtools-mcp` peers can resolve the SDK from their real npm package path. Add package-surface regression coverage and strengthen setup/runtime verification guidance.
