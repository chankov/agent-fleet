---
description: Scan agent-fleet install targets for broken symlinks, stale persona references, and overrides-file problems, then offer repairs
---

Load and follow Step 5 (Doctor preflight) of the `guided-workspace-setup` skill — without running the rest of the install flow. Use this when the user wants the repair pass on its own; the full `/setup-agent-fleet` flow runs the same scan automatically as soon as it detects prior install state.

Walk every install-target directory the chosen coding agent uses (`agents/`, `.claude/agents/`, `.opencode/agent/` (+ legacy `.opencode/agents/`), `.pi/agents/`, `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`, `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`, `.claude/references/`, `.claude/hooks/`). For each broken symlink, resolve where it pointed, look for a canonical replacement in the source `agents/` and `skills/` trees, and offer to repair or delete (persona links under `.claude/agents/` and `.opencode/agent(s)/` are repaired by regenerating a transformed copy via `transform-persona`, not by re-symlinking the raw source). Common stale names from the pre-merge persona layout: `reviewer` → `code-reviewer`, `red-team` → `security-auditor`.

Also flag and offer to rewrite any remaining YAML configs (`teams.yaml`, `peers.yaml`, etc.) that still reference removed persona names.

Also validate `.ai/agent-fleet-overrides.md` when it exists, against the schema in `docs/agent-fleet-setup.md`: unknown sections, unknown keys in known sections, invalid values for the mechanically parsed `agent-hub` keys, missing `rules:` folders, and `## env` `required:` names that are neither set nor declared in the root `.env`. These findings are advisory only — report them with fix "edit by hand", never edit the overrides file.

Present the findings per the skill's Step 1 interaction contract: print a short text summary (counts per kind, advisory findings as report-only text), then ask one `ask_user` multi-select — *"Which fixes should I apply now?"* — each option titled `<path> — <issue>` with the proposed fix as its description, chunked at ≤ 9 options; empty selection or cancel applies nothing. Without the widget, print a `# | Path | Issue | Suggested fix` table instead and take the picks as text.

Never overwrite a regular file — only act on symlinks whose target is missing. Report `repaired`, `deleted`, and `skipped` counts, and append a `## doctor-runs` line to `.ai/agent-fleet-setup.md` with the date, agent, phase (`standalone`), and counts.
