# chrome-devtools-mcp

A pi extension that bridges the [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server into pi as native tools.

Built on top of `../mcp-bridge/` — this file is a thin wrapper that supplies Chrome-specific config.

## What you get

After installing, pi exposes the full Chrome DevTools MCP toolset under the `chrome_devtools__` prefix (e.g. `chrome_devtools__navigate`, `chrome_devtools__click`, etc.). A status command `/chrome_devtools-status` reports whether the bridge connected.

This unlocks the workflow described in `skills/browser-testing-with-devtools/` for pi users.

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
