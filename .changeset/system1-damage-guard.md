---
"@chankov/agent-fleet": patch
---

Add the optional System 1 damage guard (D6): an off-by-default semantic layer over Damage-Control that can hold severe, sufficiently evidenced `bash`/`write`/`edit` calls for one exact human approval and append advisory warnings to supported results. It has its own `consumers.damageGuard` configuration with separate `remoteScopes`, durable denial state, `/af-damage-override` for one new dialog, and fresh scoped assignments for native specialists, research helpers and nested delegates.

The guard port, result capture and the single human approval wait are shared across Pi's isolated extension loaders, so the Hub's guard is consulted by the separately loaded Damage-Control. A native child takes its assignment from the spawn environment and removes it there, so Bash subprocesses cannot inherit the capability; a malformed assignment fails closed. Baseline policy stays authoritative and D6 remains experimental and unaccepted.
