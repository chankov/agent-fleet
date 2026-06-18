---
"@chankov/agent-skills": minor
---

Make the `chrome-devtools-mcp` pi extension mode-configurable via env vars, so the always-on browser stack covers both headless and headful use:

- `PI_CHROME_DEVTOOLS_MODE=headless|headed` (default headed) — adds `--headless` for background/CI runs.
- `PI_CHROME_DEVTOOLS_BROWSER_URL` — attach to an already-running Chrome via `--browserUrl` instead of launching one.
- `PI_CHROME_DEVTOOLS_USER_DATA_DIR` — use a persistent Chrome profile (`--userDataDir`), mutually exclusive with the default ephemeral `--isolated` profile.

The default launch is unchanged (headed, isolated). Because the MCP server starts once at extension load, changing these requires a pi restart / `/reload`. Documented in the extension README and `docs/pi-extensions.md`.
