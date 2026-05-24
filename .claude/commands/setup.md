---
description: Guided setup — install agent-skills artifacts into a workspace for a chosen coding agent
---

Invoke the agent-skills:guided-workspace-setup skill.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

Analyse the workspace. If prior install state is found (`.ai/agent-skills-setup.md` or a populated agent directory), run the **Doctor preflight** first (Step 5) — scan for broken symlinks and stale persona references, present findings as a table, and apply the fixes the user picks before continuing.

Then present the install menu as **one multi-select per group** (18 groups across skills, personas, commands, pi extensions/harnesses, references, hooks) with `★` marking recommendations. Each group renders as a `Pick | Item | Status | Rec | Purpose` table; the user can reply per-group with `all`, `recommended`, `none`, or a list of picks.

Offer override sections for the workspace's `.ai/agent-skills-overrides.md` based on the analysis, and record what was installed in `.ai/agent-skills-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup, re-scan for any new breakage, and report what changed.
