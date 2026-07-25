---
"@chankov/agent-fleet": minor
---

Add an optional, profile-aware, fail-closed Hermes watchdog source and lifecycle tooling. Origin-chat delivery, steering, and surgical recovery remain disabled until genuine live Hermes capability evidence exists.

The package also carries the backend and Desktop monitor plugin source as opt-in runtime source; nothing is installed, enabled, or launched by installing the package. `agent-fleet set-hermes-watchdog` gains receipt-based adoption of an identical unmanaged skill tree, and the local monitor contract adds `events` and `invoke` alongside the existing snapshot/output/cancel baseline, which is unchanged.

Two local transport fixes: the monitor socket no longer drops a response that settles after a half-closing client's FIN, and the watchdog's long-poll read timeout now covers the wait window it requests instead of expiring early and journaling a false outage.

Local runtime coverage exercises a real foreground watcher against a disposable Hub socket in observe mode. That evidence is synthetic-local: it proves neither Gate O, live origin delivery, steering, surgical execution, nor A6.
