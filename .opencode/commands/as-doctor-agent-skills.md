---
description: Scan agent-skills install targets for broken symlinks and stale persona references, then offer repairs
---

Invoke the Doctor preflight from the `guided-workspace-setup` skill (Step 5) via the `skill` tool — without running the rest of the install flow.

Walk every install-target directory the chosen coding agent uses (`agents/`, `.claude/agents/`, `.opencode/agents/`, `.codex/agents/`, `.gemini/agents/`, `.github/agents/`, `.pi/agents/`, `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`, `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`, `.claude/references/`, `.claude/hooks/`). For each broken symlink, resolve where it pointed, look for a canonical replacement in the source `agents/` and `skills/` trees, and offer to repoint or delete. Common stale names from the pre-merge persona layout: `reviewer` → `code-reviewer`, `red-team` → `security-auditor`.

Also flag and offer to rewrite any remaining YAML configs (`teams.yaml`, `peers.yaml`, etc.) that still reference removed persona names.

Never overwrite a regular file — only act on symlinks whose target is missing. Report `repaired`, `deleted`, and `skipped` counts, and append a `## doctor-runs` line to `.ai/agent-skills-setup.md` with the date and counts.
