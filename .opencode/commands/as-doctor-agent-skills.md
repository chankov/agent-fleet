---
description: Scan agent-skills install targets for broken symlinks, stale persona references, and overrides-file problems, then offer repairs
---

Invoke the Doctor preflight from the `guided-workspace-setup` skill (Step 5) via the `skill` tool — without running the rest of the install flow.

Walk every install-target directory the chosen coding agent uses (`agents/`, `.claude/agents/`, `.opencode/agent/` (+ legacy `.opencode/agents/`), `.pi/agents/`, `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`, `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`, `.claude/references/`, `.claude/hooks/`). For each broken symlink, resolve where it pointed, look for a canonical replacement in the source `agents/` and `skills/` trees, and offer to repair or delete (persona links under `.claude/agents/` and `.opencode/agent(s)/` are repaired by regenerating a transformed copy via `transform-persona`, not by re-symlinking the raw source). Common stale names from the pre-merge persona layout: `reviewer` → `code-reviewer`, `red-team` → `security-auditor`.

Also flag and offer to rewrite any remaining YAML configs (`teams.yaml`, `peers.yaml`, etc.) that still reference removed persona names.

Also validate `.ai/agent-skills-overrides.md` when it exists, against the schema in `docs/agent-skills-setup.md`: unknown sections, unknown keys in known sections, invalid values for the mechanically parsed `agent-hub` keys, missing `rules:` folders and `docs:` entry points, and `## env` `required:` names that are neither set nor declared in the root `.env`. These findings are advisory only — report them with fix "edit by hand", never edit the overrides file.

Never overwrite a regular file — only act on symlinks whose target is missing. Report `repaired`, `deleted`, and `skipped` counts, and append a `## doctor-runs` line to `.ai/agent-skills-setup.md` with the date and counts.
