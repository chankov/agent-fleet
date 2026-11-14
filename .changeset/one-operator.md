---
"@chankov/agent-fleet": minor
# release: keep-bump
---

The Hub has one work mode: the operator. The delegate-only orchestrator work mode, the `/af-work-mode` command, the Alt+M picker and the `orchestrator` catalog persona are removed. `--agents` now only picks the starting roster, `--work-mode` is accepted for one release and ignored with a warning, and a session saved in orchestrator mode continues as the operator with a one-time notice. A model profile that still maps `orchestrator:` stays valid. See docs/MIGRATION-agent-fleet.md, section 5.
