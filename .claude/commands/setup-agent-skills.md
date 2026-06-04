---
description: Guided setup — install agent-skills artifacts into a workspace for a chosen coding agent
---

Invoke the agent-skills:guided-workspace-setup skill.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

Analyse the workspace. If prior install state is found (`.ai/agent-skills-setup.md` or a populated agent directory), run the **Doctor preflight** first (Step 5) — scan for broken symlinks and stale persona references, present findings as a table, and apply the fixes the user picks before continuing.

Then present the install menu as **one multi-select per group** — **7 groups** (4 shared: Skills, Agent personas, Commands/prompts, References & Hooks; 3 pi-only: pi extensions & runtime skills, pi harnesses, External pi packages — so a claude-code workspace sees just the 4 shared groups) with `★` marking recommendations. Multi-type groups carry a leading `Group` column labelling the sub-category (lifecycle phase for Skills, `writeable`/`read-only` for personas, etc.). Each group renders as a `Pick | Item | Group | Status | Rec | Purpose` table; every row carries an explicit status text — `installed · up to date`, `installed · outdated`, `installed · modified`, `not installed`, or `broken · skipped in preflight`. Installed items are **pre-checked `[x]`** so unchecking = remove; not-installed items start `[ ]`. Per-group reply shortcuts: `all`, `recommended` (adds `★` items on top of the pre-selection — never unticks installed ones), `none`, `keep` (accept the pre-selection unchanged), or a list of picks. Never offer `setup`, `doctor`, or `guided-workspace-setup` — those are installer-only and live in the source agent-skills repo.

Unchecking an installed item means *remove it*, but **removal is scoped**: only act on items whose name is in the agent-skills inventory **and** that are recorded in `## install-status` (or are symlinks resolving into the source repo). User-authored skills, custom commands, third-party plugins, and unrelated settings/env keys are left untouched and logged as "Skipped — not owned by agent-skills".

**No cross-tool substitution.** Each row is offered only when the source file the chosen agent needs already exists — for `pi`, that means `.pi/prompts/<name>.md`, `.pi/extensions/<name>/`, etc. Never fall back to `.claude/commands/` (or another agent's tree) to satisfy a pi prompt request; items missing their per-agent source are filtered out of the menu entirely.

**pi harness companions.** When the agent is `pi`, installing/refreshing/removing any harness also refreshes its companions — the `justfile` launch recipes, the `team-up`/`coms-net` scripts, the peer/team YAML, `.pi/damage-control-rules.yaml`, and `.pi/harnesses/package.json`. Refresh the `justfile` from the current source (rewriting only the `agent-skills:harnesses` managed region so user recipes survive) so retired-harness recipes are pruned and new ones added; a stale `justfile` left after a harness change is the regression this prevents.

**No mid-apply overwrite prompts.** The Step 6 status text already warns that `installed · modified` rows will have local edits overwritten if kept ticked. The user's tick is the consent; the Step 9 confirmation is the single gate. During apply, refresh ticked items unconditionally — never pause to ask "should I overwrite this file?". Genuine errors (permission denied, missing source) still stop and report.

Offer override sections for the workspace's `.ai/agent-skills-overrides.md` based on the analysis, and record what was installed in `.ai/agent-skills-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup, re-scan for any new breakage, and report what changed.
