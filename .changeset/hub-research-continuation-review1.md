---
"@chankov/agent-fleet": patch
---

Harden researcher-led task continuation: a late outcome from a still-running original process no longer corrupts restored recovery history, a same-turn watchdog-stopped task can be continued, a failed analysis can be repeated and names its cause, absolute dispatch scope and recorded parallel instances no longer make continuation impossible, and `/af-recover continue` reports its outcome to the dispatcher.

Normalize relative dispatch scope before checking containment so valid in-workspace paths with parent segments can continue without changing the original invocation; paths that resolve outside the workspace remain refused before analysis or approval.
