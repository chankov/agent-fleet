# chrome-devtools-mcp

A pi extension that bridges the [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server into pi as native tools.

Built on top of `../mcp-bridge/` — this file is a thin wrapper that supplies Chrome-specific config.

## What you get

After installing, pi exposes the full Chrome DevTools MCP toolset under the `chrome_devtools__` prefix (e.g. `chrome_devtools__navigate`, `chrome_devtools__click`, etc.). A status command `/chrome_devtools-status` reports whether the bridge connected.

This unlocks the workflow described in `skills/browser-testing-with-devtools/` for pi users.

## When to use this vs `bowser`

These tools are the **interactive** browser stack — a live headful Chrome with `chrome_devtools__*` DOM/console/network/performance tools, driven by the `web-debugger` persona (run it as a coms peer so the extension loads into its process — see `.pi/agents/peers.yaml`). For **automated, headless, parallel** browser work that can run as a dispatched `--no-extensions` subagent, use the `bowser` persona / `.pi/skills/bowser/` instead (it drives `playwright-cli` over Bash). They are complementary; the full decision lives in [docs/pi-extensions.md](../../../docs/pi-extensions.md#two-browser-stacks--when-to-use-which).

## Configuration

The bridge launches headed (interactive) by default. Override via env vars before starting pi (the MCP server starts once at extension load, so a change needs a pi restart / `/reload` to take effect):

| Variable | Effect |
|----------|--------|
| `PI_CHROME_DEVTOOLS_MODE` | `headless` runs Chrome with no UI (background / CI); anything else (default) is headed. |
| `PI_CHROME_DEVTOOLS_BROWSER_URL` | Attach to an already-running Chrome (e.g. `http://127.0.0.1:9222`) instead of launching one. When set, mode/profile flags are governed by that instance. |
| `PI_CHROME_DEVTOOLS_USER_DATA_DIR` | Use a persistent Chrome profile at this path (cookies/storage survive restarts). Mutually exclusive with the default ephemeral `--isolated` profile. |

```bash
PI_CHROME_DEVTOOLS_MODE=headless pi      # background/headless
PI_CHROME_DEVTOOLS_MODE=headed pi        # interactive (default)
```

## Install

Symlink both extensions from this repo into your project's `.pi/extensions/`:

```bash
mkdir -p .pi/extensions
ln -s /path/to/agent-skills/.pi/extensions/mcp-bridge          .pi/extensions/mcp-bridge
ln -s /path/to/agent-skills/.pi/extensions/chrome-devtools-mcp .pi/extensions/chrome-devtools-mcp
```

`mcp-bridge` is a sibling library; `chrome-devtools-mcp` imports it via the relative path. Runtime dependencies are hoisted to `.pi/extensions/package.json` — run `npm ci` there once after cloning `agent-skills` (see [docs/pi-setup.md](../../../docs/pi-setup.md#optional-pi-extensions)).

## Verify

Run `pi` from the project, then:

```
/chrome_devtools-status
```

Expect: `Chrome DevTools MCP connected. Registered N tool(s).`

Type `chrome_devtools__` in tool autocomplete to see the wrapped tools.

## Note

This extension exists because pi does not yet have first-class MCP infrastructure. Once pi supports MCP servers natively, this wrapper will be retired in favor of the native mechanism.
