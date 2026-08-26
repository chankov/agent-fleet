---
# release: keep-bump
"@chankov/agent-fleet": major
---

Remove `/af-persona` and the `persona-gate` override. The hub dispatcher is the generated Fleet prompt and `/af-work-mode` posture; leftover `persona-gate` keys are ignored and flagged by doctor. `agents/orchestrator.md` remains as the catalog description of that role.
