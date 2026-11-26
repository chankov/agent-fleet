# chrome-devtools-mcp

A pi extension that bridges the [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server into pi as native tools.

Built on top of `../mcp-bridge/` — this file is a thin wrapper that supplies Chrome-specific config.

## What you get

After installing, pi exposes the full Chrome DevTools MCP toolset under the `chrome_devtools__` prefix (e.g. `chrome_devtools__navigate`, `chrome_devtools__click`, etc.). A status command `/af-chrome-devtools-status` reports whether the bridge connected.

This unlocks the workflow described in `skills/browser-testing-with-devtools/` for pi users.

## When to use this vs `bowser`

These tools are the **interactive** browser stack — a live headful Chrome with `chrome_devtools__*` DOM/console/network/performance tools. They load into the Hub with `just fleet --browser` and into every pi coms peer that is not read-only (`just fleet peer <name>`); a native subagent does not get them. Such work carries the `browser-debugging` practice: a researcher observes and diagnoses, an editor performs stateful interaction or writes test artifacts (see [the practice catalogue](../../../docs/agents.md#practices)). For **automated, headless, parallel** browser work that can run in a dispatched `--no-extensions` subagent, use `.pi/skills/bowser/` instead (it drives `playwright-cli` over Bash, so it needs a role with a shell, such as an editor). They are complementary; the full decision lives in [docs/pi-extensions.md](../../../docs/pi-extensions.md#two-browser-stacks--when-to-use-which).

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

```bash
npx @chankov/agent-fleet install --agent pi --allow-exec --yes \
  --items pi-extension:mcp-bridge,pi-extension:chrome-devtools-mcp
```

Select both: `mcp-bridge` is a sibling library that `chrome-devtools-mcp` imports via a relative path, so it must sit beside it under `.pi/extensions/`. Runtime dependencies live in `.pi/extensions/package.json`, which is copied in with the extensions; `--allow-exec` runs `npm ci --prefix .pi/extensions` as part of the install, and without it that step is printed and left for you (see [docs/pi-setup.md](../../../docs/pi-setup.md#optional-pi-extensions)). They are also root production dependencies of the published package, so a pi-package install resolves them from the package root.

## Verify

Run `pi` from the project, then:

```
/af-chrome-devtools-status
```

Expect: `Chrome DevTools MCP connected. Registered N tool(s).`

Type `chrome_devtools__` in tool autocomplete to see the wrapped tools.

## Note

This extension exists because pi does not yet have first-class MCP infrastructure. Once pi supports MCP servers natively, this wrapper will be retired in favor of the native mechanism.
