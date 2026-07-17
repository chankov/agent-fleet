# coms

Peer-to-peer messaging between pi agents on the same machine.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Lets multiple pi agents running on the same machine talk to each other. Each agent listens
on a single endpoint — a unix socket on POSIX, a named pipe on Windows — and discovers
peers through per-project registry files under `~/.pi/coms/projects/<project>/agents/`.

Surfaces a live "pool" widget of connected peers, with ping and keepalive cycles and a
clean shutdown lifecycle.

## Presence backends: herdr vs files

Presence (who's alive, what state they're in) is pluggable; the **envelope transport,
tools, and pool-scope boundary are identical in both**:

- **herdr** — active automatically when the session runs inside a [herdr](https://herdr.dev)
  pane (`HERDR_ENV=1`) and the server answers ping. Presence goes push: this peer reports
  itself via `pane.report_agent` + `pane.report_metadata` (`custom_status` =
  `<name> <pct>% q<depth>`, capped at 32 chars by herdr), and the pool widget populates
  from `agent.list` + `events.subscribe` — **no periodic ping traffic**; peer state
  changes arrive within ~1s and dead panes disappear on `pane.exited`. Turn state
  (idle/working) in the herdr sidebar comes from herdr's own pi integration when
  installed (`herdr integration install`); coms adds the name/context/queue annotation.
- **files** — everywhere else: the original 10s ping cycle over the peer endpoints,
  byte-for-byte today's behavior.

The file registry keeps being written in BOTH backends (it carries the full agent card
that herdr's 32-char `custom_status` cannot, and keeps this peer discoverable to peers
running outside herdr panes). Peers outside herdr panes appear as dimmed "pending" rows
when you are on the herdr backend.

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
`damage-control-continue` + `coms` *on top of* normal extension discovery (no `--no-extensions`), so the
local-only tools stay scoped to that dispatcher process and never leak into the `--no-extensions`
specialists an `agent-hub` session spawns.

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes).
