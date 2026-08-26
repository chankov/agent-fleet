---
# release: keep-bump
"@chankov/agent-fleet": major
---

Consolidate Fleet execution controls under Work Mode. Keep `/af-work-mode`, `Alt+M`, and `--work-mode`; remove `/af-posture`, `--posture`, and the deprecated fast/standard/strict mode aliases. Rename the runtime types, state, UI, tests, and documentation while retaining read-only compatibility for legacy persisted posture entries.
