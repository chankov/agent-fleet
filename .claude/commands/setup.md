---
description: Guided setup — install agent-skills artifacts into a workspace for a chosen coding agent
---

Invoke the agent-skills:guided-workspace-setup skill.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

Analyse the workspace, then present a checklist of installable artifacts — skills, agent personas, commands/prompts, pi extensions and harnesses, references, and hooks — marking what is already installed.

Offer override sections for the workspace's `.ai/agent-skills-overrides.md` based on a brief analysis of the project, and record what was installed in `.ai/agent-skills-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup and report what changed.
