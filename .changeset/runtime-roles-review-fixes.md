---
"@chankov/agent-fleet": patch
---

Fixes from the independent review of the runtime roles release.

- A review closes the review obligation, or registers operator current-state evidence, only when the reviewer was assigned the `independent-review` practice. A reviewer consulted with another practice (for example `testing`) gives advice; its result stays preliminary with the reason `review_practice_missing`.
- A workflow-only install now brings the `editor` and `researcher` roles its flows run, and they cannot be uninstalled from under the workflow runtime.
- `spawn_research` takes the researcher role's model and thinking for the assigned practices in both forms (with or without `persona`); an explicit helper `model` still wins, and the chat model is used only when no researcher role is installed.
- Poll refuses a panel without an `integrator: true` voice before any budget charge or voice start; Debate still accepts such a panel.
- `dispatch_agent` `after` may name the same role as the new assignment: it waits for the earlier assignments of that instance, in arrival order, instead of being refused as waiting on itself. A real cycle is still refused.
- `agent-fleet doctor` never echoes an unknown key from `.ai/system1.json`; it names the known parent and numbers the unknown entries.
- The Debate digest keeps the change history of a voice that dropped out in a later round.
