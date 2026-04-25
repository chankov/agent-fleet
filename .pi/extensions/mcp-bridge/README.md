# mcp-bridge

A reusable factory for turning any stdio MCP server into a pi extension.

This is a **library**, not a standalone pi extension. It is consumed by other extensions in `.pi/extensions/` (for example, `chrome-devtools-mcp/`). pi will not load it directly.

## What it does

Given a config describing how to spawn an MCP server, the factory returns a pi extension that:

1. Spawns the MCP server over stdio (`StdioClientTransport`).
2. Lists the server's tools via `listTools`.
3. Registers each tool with pi under a configurable prefix.
4. Forwards calls and normalizes MCP content (`text`, `image`, `resource`) back to pi.
5. Registers a status command and cleans up on `session_shutdown`.

## Usage

```ts
import { createMcpBridgeExtension } from "../mcp-bridge/index.js";

export default createMcpBridgeExtension({
  prefix: "my_server__",
  command: "npx",
  args: ["-y", "some-mcp-server@latest"],
});
```

## Config

| Field | Required | Default | Description |
|---|---|---|---|
| `prefix` | yes | — | Prefix prepended to every registered pi tool name (e.g. `chrome_devtools__`). |
| `command` | yes | — | Executable used to spawn the MCP server (e.g. `npx`, `node`, an absolute path). |
| `args` | yes | — | Arguments passed to `command`. |
| `clientName` | no | `pi-<prefix>` | Identifier sent to the MCP server during connection. |
| `labelPrefix` | no | humanized `prefix` | Shown in pi tool labels and status messages. |
| `statusCommandName` | no | `<prefix>-status` | Slash command that reports bridge status. |

## Why this exists

pi does not yet have first-class MCP support. This bridge is a **stopgap**: it lets pi consume MCP servers today. When pi gains native MCP support, individual wrapper extensions can be retired or replaced; this library will then be deprecated.

## Dependencies

`@mariozechner/pi-coding-agent`, `@modelcontextprotocol/sdk`, and `typebox` are declared as **peer dependencies**. Each wrapper extension that consumes this factory should declare them as regular dependencies, so they install once at the consuming project level.
