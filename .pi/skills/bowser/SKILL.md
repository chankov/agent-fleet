---
name: bowser
description: Headless browser automation using Playwright CLI. Use when you need headless browsing, parallel browser sessions, UI testing, screenshots, web scraping, or browser automation that can run in the background. Keywords - playwright, headless, browser, test, screenshot, scrape, parallel.
allowed-tools: Bash
---

# Playwright Bowser

## Purpose

Automate browsers using `playwright-cli` — a token-efficient CLI for Playwright. Runs headless by default, supports parallel sessions via named sessions (`-s=`), and doesn't load tool schemas into context.

## Requirements

This skill drives the external **Playwright Agent CLI** (`playwright-cli`). It is **not** bundled with agent-skills — install it once before using this skill (the guided setup checks for it when `bowser` is selected).

- **Node.js 20+**
- **`playwright-cli`** — install globally:

```bash
npm install -g @playwright/cli@latest
playwright-cli --help                 # verify it responds
```

Or run ad-hoc without a global install via `npx playwright-cli <command>`.

Browsers are downloaded automatically on first use; to pre-install explicitly:

```bash
playwright-cli install-browser               # default (chromium)
playwright-cli install-browser firefox       # a specific browser
playwright-cli install-browser --with-deps   # include system dependencies
```

Full install docs: <https://playwright.dev/agent-cli/installation>

## When to use this vs Chrome DevTools MCP

This skill (`playwright-cli`) and the `chrome-devtools-mcp` pi extension are **complementary**, not redundant — they differ by tool model, not just headless-vs-headful (both can do either):

- **`bowser` / `playwright-cli` (this skill)** — CLI-driven, headless-first, parallel named sessions, token-efficient (no tool schemas in context). It needs only Bash, so it works as a **dispatched subagent** under `--no-extensions`. Use it for automated, parallel, or background runtime-UI evidence and scraping.
- **`web-debugger` / `chrome-devtools-mcp`** — live `chrome_devtools__*` tools (DOM/console/network/performance traces) for **interactive headful** debugging with a human in the loop. Those tools come from an always-on extension, so they are reachable in the main session or a **coms peer**, not a `--no-extensions` subagent. Use it to *understand* a failure in a running dev app.

## Key Details

- **Headless by default** — pass `--headed` to `open` to see the browser
- **Parallel sessions** — use `-s=<name>` to run multiple independent browser instances
- **Persistent profiles** — cookies and storage state preserved between calls
- **Token-efficient** — CLI-based, no accessibility trees or tool schemas in context
- **Vision mode** (opt-in) — set `PLAYWRIGHT_MCP_CAPS=vision` to receive screenshots as image responses in context instead of just saving to disk

## Sessions

**Always use a named session.** Derive a short, descriptive kebab-case name from the user's prompt. This gives each task a persistent browser profile (cookies, localStorage, history) that accumulates across calls.

```bash
# Derive session name from prompt context:
# "test the checkout flow on mystore.com" → -s=mystore-checkout
# "scrape pricing from competitor.com"    → -s=competitor-pricing
# "UI test the login page"               → -s=login-ui-test

playwright-cli -s=mystore-checkout open https://mystore.com --persistent
playwright-cli -s=mystore-checkout snapshot
playwright-cli -s=mystore-checkout click e12
```

Managing sessions:
```bash
playwright-cli list                                     # list all sessions
playwright-cli close-all                                # close all sessions
playwright-cli -s=<name> close                          # close specific session
playwright-cli -s=<name> delete-data                    # wipe session profile
```

## Quick Reference

```
Core:       open [url], goto <url>, click <ref>, fill <ref> <text>, type <text>, snapshot, screenshot [ref], close
Navigate:   go-back, go-forward, reload
Keyboard:   press <key>, keydown <key>, keyup <key>
Mouse:      mousemove <x> <y>, mousedown, mouseup, mousewheel <dx> <dy>
Tabs:       tab-list, tab-new [url], tab-close [index], tab-select <index>
Save:       screenshot [ref], pdf, screenshot --filename=f
Storage:    state-save, state-load, cookie-*, localstorage-*, sessionstorage-*
Network:    route <pattern>, route-list, unroute, network
DevTools:   console, run-code <code>, tracing-start/stop, video-start/stop
Sessions:   -s=<name> <cmd>, list, close-all, kill-all
Config:     open --headed, open --browser=chrome, resize <w> <h>
```

## Workflow

1. Derive a session name from the user's prompt and open with `--persistent` to preserve cookies/state. Always set the viewport via env var at launch:
```bash
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 playwright-cli -s=<session-name> open <url> --persistent
# or headed:
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 playwright-cli -s=<session-name> open <url> --persistent --headed
# or with vision (screenshots returned as image responses in context):
PLAYWRIGHT_MCP_VIEWPORT_SIZE=1440x900 PLAYWRIGHT_MCP_CAPS=vision playwright-cli -s=<session-name> open <url> --persistent
```

2. Get element references via snapshot:
```bash
playwright-cli snapshot
```

3. Interact using refs from snapshot:
```bash
playwright-cli click <ref>
playwright-cli fill <ref> "text"
playwright-cli type "text"
playwright-cli press Enter
```

4. Capture results:
```bash
playwright-cli screenshot
playwright-cli screenshot --filename=output.png
```

5. **Always close the session when done.** This is not optional — close the named session after finishing your task:
```bash
playwright-cli -s=<session-name> close
```

## Configuration

If a `playwright-cli.json` exists in the working directory, use it automatically. If the user provides a path to a config file, use `--config path/to/config.json`. Otherwise, skip configuration — the env var and CLI defaults are sufficient.

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": { "headless": true },
    "contextOptions": { "viewport": { "width": 1440, "height": 900 } }
  },
  "outputDir": "./screenshots"
}
```

## Full Help

Run `playwright-cli --help` or `playwright-cli --help <command>` for detailed command usage.

See the [Playwright Agent CLI docs](https://playwright.dev/agent-cli/installation) for full documentation.
