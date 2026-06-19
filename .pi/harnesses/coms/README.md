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

- `/coms` — open the coms control surface; `--project <name>` retargets the pool (use `*` for
  every project) and `--all` toggles private (`--explicit`) peers into view
- `coms_list` / `coms_send` / `coms_get` / `coms_await` tools — discover peers and
  exchange messages

## Pool scope is the reach boundary

The pool widget defines who you can reach: `coms_list` and `coms_send` resolve targets through one
`peersInScope()` helper, so a peer is reachable only if it is in the pool. By default the
pool is your own project and excludes `--explicit` peers. **Widening is a human-only action** — the
`coms_list` tool cannot widen scope; only `/coms --project` / `/coms --all` can. This prevents an
agent from messaging a cross-project peer that the widget never showed.

## Requires

Nothing in-repo — the peer registry lives at `~/.pi/coms/` and is created at runtime.

## Usage

```bash
pi -e .pi/harnesses/coms/index.ts
```

For a guarded coms node that also keeps every auto-discovered local extension (MCP bridges,
project-specific extensions) and command, use the `just safe-coms <name>` recipe — it loads
`damage-control` + `coms` *on top of* normal extension discovery (no `--no-extensions`), so the
local-only tools stay scoped to that dispatcher process and never leak into the `--no-extensions`
specialists an `agent-hub` session spawns.

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
