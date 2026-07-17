# ask-user-remote

Harness wrapper for `pi-ask-user` that preserves the stock `ask_user` UI and result shape while optionally racing it against the Hermes `user-remote` coms peer.

- The stock `pi-ask-user` extension is loaded through a capture proxy; its `ask_user` tool is not registered directly.
- If no live `user-remote` peer is present at call time, the wrapper calls stock `execute` with the original arguments and signal unchanged.
- If `user-remote` is present, the wrapper races local stock UI against the remote coms request using `race-core.js`; first answer wins and local-first emits one best-effort cancel.
- If another extension already registered `ask_user`, registration failure is caught and logged as a warning instead of crashing the session.

Tests use fakes for the stock TUI and coms peer. The abort test proves signal propagation and the stock-shaped `{cancelled:true}` result through a fake captured tool; it does not drive a live TUI overlay.
