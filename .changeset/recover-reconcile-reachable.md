---
"@chankov/agent-fleet": patch
---

`/af-recover reconcile` can now clear a builder attempt that failed verification once an independent review approves it at the current revision. Two conditions had made this unreachable: the review's coverage left out attempts that exited 0 but failed verification, and the review counted only when it listed a non-blocking suggestion. A nonblocking review now means what the recovery contract says: an approving verdict with zero blocking findings. A rejecting review never clears an attempt, whatever it lists. Reconcile still clears only the technical block; the failed delivery and every open requirement stay open.
