---
description: Guided setup — install agent-skills artifacts into a workspace for a chosen coding agent
---

Invoke the `guided-workspace-setup` skill via the `skill` tool.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

Analyse the workspace, then present a checklist of installable artifacts as **7 grouped multi-selects** (4 shared: Skills, Agent personas, Commands/prompts, References & Hooks; 3 pi-only: pi extensions & runtime skills, pi harnesses, External pi packages — an opencode workspace sees just the 4 shared groups). Multi-type groups carry a `Group` column labelling the sub-category. Mark what is already installed (pre-checked `[x]`). On `pi`, installing/refreshing/removing any harness also refreshes its companions — the `justfile` launch recipes (managed region only, so user recipes survive), the `team-up`/`coms-net` scripts, the peer/team YAML, `.pi/damage-control-rules.yaml`, and `.pi/harnesses/package.json` — refreshed from the current source so retired-harness recipes are pruned and new ones added.

Offer override sections for the workspace's `.ai/agent-skills-overrides.md` based on a brief analysis of the project, and record what was installed in `.ai/agent-skills-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup and report what changed.
