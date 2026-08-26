---
# release: keep-bump
"@chankov/agent-fleet": major
---

Remove the manual research lifecycle slash commands `/af-research`, `/af-research-cont`, `/af-research-rm`, `/af-research-clear`, and `/af-agents-cont`. Read-only reconnaissance now enters through the dispatcher's bounded `spawn_research` tool or the automatic specialist `NEEDS_RESEARCH:` pipe; the existing add/drop, kill, and restart controls remain available.
