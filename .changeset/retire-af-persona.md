---
# release: keep-bump
"@chankov/agent-fleet": major
---

Remove `/af-persona` and the `persona-gate` override. The hub dispatcher is the generated Fleet prompt using the Work Mode selected through `/af-work-mode`; leftover `persona-gate` keys are ignored and flagged by doctor. `agents/orchestrator.md` remains as the catalog description of that role.
