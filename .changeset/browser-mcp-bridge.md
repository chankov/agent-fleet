---
"@chankov/agent-fleet": patch
---

`setup` with the `browser` feature now also installs `mcp-bridge`, the library `chrome-devtools-mcp` imports; before, the browser extension could fail to load. Selecting `pi-extension:chrome-devtools-mcp` brings the bridge with it, and uninstall keeps the bridge while the browser extension stays.
