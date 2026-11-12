---
"@chankov/agent-fleet": patch
---

`agent-fleet doctor` no longer reports `## workflows` in `.ai/agent-fleet-overrides.md` as an unknown section that no reader loads. It knows `quality:` and `quality.<repository>:` and flags a misspelled key in that section. The setup reference documents the section and adds it to the overrides template. The architecture and workflow docs describe workspaces whose root holds nested repositories, including `--worktree` and `run_flow` `repo:`.
