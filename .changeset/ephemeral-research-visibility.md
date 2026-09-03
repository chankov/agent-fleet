---
"@chankov/agent-fleet": patch
---

Make native research helpers live-only: they appear in the Fleet Dashboard (`Alt+A`) while running, never as main-dispatcher cards, and are removed immediately on every terminal outcome. Session, transcript, findings, and `/af-agents-history` records remain; finished `rN` restart and `research-keep` are retired.
