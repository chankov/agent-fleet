---
"@chankov/agent-fleet": patch
---

Lower the automatic context policy to a 50% minimum, 60% warning, 70% compaction target and 80% ceiling. Automatic compaction re-arms when usage falls below 60% or after the history grows by 10% of the window over the first post-compaction measurement, so small context windows are not left waiting. The ceiling stops work after a failed recovery or when even the compacted baseline is at or above 80%; a baseline between 70% and 80% warns once and keeps working. The Hub triages specialist questions before escalating unresolved material decisions to the human, and the footer shows the provider and full model id.
