# coms

Peer-to-peer messaging between pi agents on the same machine.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Lets multiple pi agents running on the same machine talk to each other. Each agent listens
on a single endpoint — a unix socket on POSIX, a named pipe on Windows — and discovers
peers through per-project registry files under `~/.pi/coms/projects/<project>/agents/`.

Surfaces a live "pool" widget of connected peers, with ping and keepalive cycles and a
clean shutdown lifecycle.

## Commands & tools

- `/coms` — open the coms control surface
- `coms_list` / `coms_send` / `coms_get` / `coms_await` tools — discover peers and
  exchange messages

## Requires

Nothing in-repo — the peer registry lives at `~/.pi/coms/` and is created at runtime.
For an HTTP/SSE transport that works across hosts, use [`coms-net`](../coms-net/README.md) instead.

## Usage

```bash
pi -e .pi/harnesses/coms/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
