---
"@chankov/agent-skills": major
---

Retire the `scout` persona and remove the `pi-pi` harness

- `agents/scout.md` is gone. Use `spawn_research` (agent-hub) or the `planner` persona for read-only recon; install records and setup docs no longer offer `scout`.
- The `pi-pi` meta-agent harness (`.pi/harnesses/pi-pi/`), its expert personas (`agents/pi-pi/`), the `ext-pi-pi` just recipe, the `pi-pi` team in `.pi/agents/teams.yaml`, and the `docs/pi-specs/pi-pi.md` spec are removed. `FIRECRAWL_API_KEY` is no longer used by anything in this repo.
- The doctor scan no longer walks `agents/pi-pi/` or `.pi/agents/pi-pi/`; existing installs with `scout` or `pi-pi` symlinks will surface them as broken links to repair or delete on the next doctor run.
