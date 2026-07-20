# ask-user-remote

Harness wrapper for `pi-ask-user` that preserves the stock `ask_user` UI and result shape while optionally racing it against the Hermes `user-remote` coms peer.

The experimental Codex Remote-Control conductor is **not** an inbound `ask_user` route. It initiates approval-gated outbound delegation from Android; Hermes remains the only phone answer participant in this race. See the [Codex conductor runbook](../../../docs/codex-remote-conductor.md).

- The stock `pi-ask-user` extension is loaded through a capture proxy; its `ask_user` tool is not registered directly.
- If no live `user-remote` peer is present at call time, the wrapper calls stock `execute` with the original arguments and signal unchanged.
- If `user-remote` is present, the wrapper races local stock UI against the remote coms request using `race-core.js`; first answer wins and local-first emits one best-effort cancel.
- If another extension already registered `ask_user`, registration failure is caught and logged as a warning instead of crashing the session.

## Double-load protection

Do **not** also list `npm:pi-ask-user` in pi settings `packages` (project `.pi/settings.json` or global `~/.pi/agent/settings.json`) — the harness loads the stock extension itself. A settings-listed copy is loaded by pi core outside the harness's control, and if the harness happened to register `ask_user` first, pi core would hard-crash the session with `Tool "ask_user" conflicts` while loading the package (load order between the two is a race).

The harness defends against this with a startup preflight: it scans both settings files for a `pi-ask-user` package entry, and if one is found it logs a warning and skips registering its wrapper entirely, so the stock package registers alone and the session survives regardless of load order. The cost is that remote answer racing is disabled until the entry is removed — the warning says so. The try/catch on registration remains as the second layer for the package-first order (or any other extension owning `ask_user`).

Tests use fakes for the stock TUI and coms peer. The abort test proves signal propagation and the stock-shaped `{cancelled:true}` result through a fake captured tool; it does not drive a live TUI overlay.
