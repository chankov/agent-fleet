---
description: Guided setup — install agent-fleet artifacts into a workspace for a chosen coding agent
---

Invoke the `guided-workspace-setup` skill via the `skill` tool.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask for it. Detect the running coding agent and confirm it with the user.

The Skills group draws from **two roots**: fleet-native `skills/` and the vendored upstream import `vendor/agent-skills-upstream/skills/` (see `docs/UPSTREAM-SKILLS.md`). On a name collision the native copy wins — never offer the vendored duplicate as a separate row.

Analyse the workspace, then present the install menu per the skill's Step 1 interaction contract: with a native select widget, open with the **Express question** (`Recommended ★` / `Everything` / `Custom — group by group`, or the installed-state variants), and on `Custom` run the **7 groups** (4 shared: Skills, Agent personas, Commands/prompts, References & Hooks; 3 pi-only — an opencode workspace sees just the 4 shared groups) as single-select quick screens with multi-select drill-ins only behind `Customise`, chunked by sub-category; installed state shows as counts and plain-words descriptions (no pre-checking), removal only via an explicit `Remove some…` selection, and cancel = keep-as-is. Without a widget, fall back to the skill's tabular format (pre-checked `[x]` tables with text replies). On `pi`, installing/refreshing/removing any harness also refreshes its companions — the `justfile` launch recipes (managed region only, so user recipes survive), the `team-up` script, the peer/team YAML, `.pi/damage-control-rules.yaml`, and `.pi/harnesses/package.json` — refreshed from the current source so retired-harness recipes are pruned and new ones added. `agent-hub` requires only `damage-control-continue` and `ask-user-remote`. Treat the retired `damage-control` hard-stop directory as `gone`: remove it only when recorded and unchanged against the recorded snapshot, or when it is a symlink into the source root (including a broken retirement link); preserve every user-modified or unowned copy.

**Personas are generated for opencode.** The personas group lists the full availability roster from `node <source-root>/bin/cli.js transform-persona --list --agent opencode` (pi-only personas — `bowser`, `orchestrator` — are excluded). The apply step installs them into `.opencode/agent/<name>.md` via `transform-persona --agent opencode --workspace <workspace> <name…>` — always a generated copy, even in symlink mode — and records the rows with `transformed: true`; status checks diff against the generated output, not the raw canonical source.

Offer override sections for the workspace's `.ai/agent-fleet-overrides.md` based on a brief analysis of the project, and record what was installed in `.ai/agent-fleet-setup.md`. Summarise the full plan and wait for explicit confirmation before writing anything, then perform the setup and report what changed.
