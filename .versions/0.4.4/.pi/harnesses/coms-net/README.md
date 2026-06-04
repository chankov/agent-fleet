# coms-net

HTTP/SSE pi agent communication network (client).

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

A drop-in successor to [`coms`](../coms/README.md) whose transport is a dedicated HTTP/SSE
hub instead of per-agent unix sockets / named pipes — so agents can communicate across
hosts, not just on one machine. The tool surface is renamed for total separation from v1,
so `coms` and `coms-net` can be loaded together without collisions.

- tools: `coms_net_list` / `coms_net_send` / `coms_net_get` / `coms_net_await`
- slash command: `/coms-net`
- registry root: `~/.pi/coms-net/`

## Requires

- **The hub server** — [`scripts/coms-net-server.ts`](../../../scripts/coms-net-server.ts),
  started separately (see Usage).
- Environment (optional, for LAN/remote hubs):
  - `PI_COMS_NET_AUTH_TOKEN` — shared secret; required to bind beyond `127.0.0.1`
  - `PI_COMS_NET_PORT` — pin the hub port (blank = OS-assigned)
  - `PI_COMS_NET_SERVER_URL` — hub URL for clients (blank = auto-discover local `server.json`)

## Usage

```bash
# 1. start the hub (pure Node built-ins, Node >= 22.6)
node --experimental-strip-types scripts/coms-net-server.ts

# 2. start a pi client (auto-discovers the local server.json)
pi -e .pi/harnesses/coms-net/index.ts

# remote hub
pi -e .pi/harnesses/coms-net/index.ts --server-url http://host:port --auth-token <tok> --name planner
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
- Server launch changed from `bun scripts/coms-net-server.ts` to
  `node --experimental-strip-types scripts/coms-net-server.ts` (Node >= 22.6) — this repo
  standardises on the checked-in Node runtime path.
