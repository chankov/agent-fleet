---
description: Scan agent-fleet install targets for broken symlinks, stale persona references, and overrides-file problems, then offer repairs
---

Invoke the Doctor scan from the `agent-fleet:guided-workspace-setup` skill — Step 5 (the preflight scan) — without running the rest of the install flow. Use this when the user wants the repair pass on its own; the full `/setup-agent-fleet` flow runs the same scan automatically as soon as it detects prior install state.

Walk every install-target directory the chosen coding agent uses (`agents/`, `.claude/agents/`, `.opencode/agent/` (+ legacy `.opencode/agents/`), `.pi/agents/`, `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`, `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`, `.claude/references/`, `.claude/hooks/`). For each broken symlink, resolve where it pointed, look for a canonical replacement in the source `agents/` and `skills/` trees, and offer to repair or delete (persona links under `.claude/agents/` and `.opencode/agent(s)/` are repaired by regenerating a transformed copy via `transform-persona`, not by re-symlinking the raw source). Common stale names from the pre-merge persona layout: `reviewer` → `code-reviewer`, `red-team` → `security-auditor`.

Also flag and offer to rewrite any remaining YAML configs (`teams.yaml`, `peers.yaml`, etc.) that still reference removed persona names.

Also flag malformed peer entries in `.pi/agents/peers.yaml`: field lines (`persona:`, `model:`, ...) that sit under a team heading before any `- name: ...` list item. The team-up launcher's minimal parser silently drops such lines, so the peer never spawns and nothing errors — the usual cause is a `- name:` line lost in an edit. These findings are advisory only: report them with the missing `- name: <peer>` suggestion, never rewrite the file.

Also validate `.ai/agent-fleet-overrides.md` when it exists, against the schema in `docs/agent-fleet-setup.md`: unknown sections, unknown keys in known sections, invalid values for the mechanically parsed `agent-hub` keys, missing `rules:` folders and `docs:` entry points, and `## env` `required:` names that are neither set nor declared in the root `.env`. These findings are advisory only — report them with fix "edit by hand", never edit the overrides file.

Present findings as a `# | Path | Issue | Suggested fix` table and ask the user to pick which fixes to apply.

Never overwrite a regular file — only act on symlinks whose target is missing. Report `repaired`, `deleted`, and `skipped` counts, and append a `## doctor-runs` line to `.ai/agent-fleet-setup.md` with the date, agent, phase (`standalone`), and counts.
