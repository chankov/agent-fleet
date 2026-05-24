---
description: Guided setup — install agent-skills artifacts into a workspace for a chosen coding agent
---

Load and follow the `guided-workspace-setup` skill before proceeding.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

Analyse the workspace. If prior install state is found (`.ai/agent-skills-setup.md` or a populated agent directory), run the **Doctor preflight** first (Step 5) — scan for broken symlinks and stale persona references, present findings as a table, and apply the fixes the user picks before continuing.

Then present the install menu as **one multi-select per group** (18 groups across skills, personas, commands, pi extensions/harnesses, references, hooks) with `★` marking recommendations. Each group renders as a `Pick | Item | Status | Rec | Purpose` table; every row carries an explicit status text — `installed · up to date`, `installed · outdated`, `installed · modified`, `not installed`, or `broken · skipped in preflight`. Installed items are **pre-checked `[x]`** so unchecking = remove; not-installed items start `[ ]`. Per-group reply shortcuts: `all`, `recommended` (adds `★` items on top of the pre-selection — never unticks installed ones), `none`, `keep` (accept the pre-selection unchanged), or a list of picks. Never offer `setup`, `doctor`, or `guided-workspace-setup` — those are installer-only and live in the source agent-skills repo.

Unchecking an installed item means *remove it*, but **removal is scoped**: only act on items whose name is in the agent-skills inventory **and** that are recorded in `## install-status` (or are symlinks resolving into the source repo). User-authored skills, custom commands, third-party plugins, and unrelated settings/env keys are left untouched and logged as "Skipped — not owned by agent-skills".

**No cross-tool substitution.** Each row is offered only when the source file the chosen agent needs already exists — for `pi`, that means `.pi/prompts/<name>.md`, `.pi/extensions/<name>/`, etc. Never fall back to `.claude/commands/` (or another agent's tree) to satisfy a pi prompt request; items missing their per-agent source are filtered out of the menu entirely.

**No mid-apply overwrite prompts.** The Step 6 status text already warns that `installed · modified` rows will have local edits overwritten if kept ticked. The user's tick is the consent; the Step 9 confirmation is the single gate. During apply, refresh ticked items unconditionally — never pause to ask "should I overwrite this file?". Genuine errors (permission denied, missing source) still stop and report.

Offer override sections for the workspace's `.ai/agent-skills-overrides.md` based on the analysis, and record what was installed in `.ai/agent-skills-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup, re-scan for any new breakage, and report what changed.
