---
"@chankov/agent-skills": minor
---

Initial npm release. Ships the full skills catalog, agent personas, slash
commands, and pi extensions as an installable package, with a thin CLI
(`npx agent-skills init`) that hands off to the LLM-driven
`guided-workspace-setup` skill. Adds version-aware updates: the install record
now embeds the package version, and re-running `/setup` after a version bump
surfaces a per-artifact three-way diff (source@recorded vs installed copy vs
source@current) before touching any file.
