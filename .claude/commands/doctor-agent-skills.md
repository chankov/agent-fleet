---
description: Scan agent-skills install targets for broken symlinks and stale persona references, then offer repairs
---

Invoke the Doctor scan from the `agent-skills:guided-workspace-setup` skill — Step 5 (the preflight scan) — without running the rest of the install flow. Use this when the user wants the repair pass on its own; the full `/setup-agent-skills` flow runs the same scan automatically as soon as it detects prior install state.

Walk every install-target directory the chosen coding agent uses (`agents/`, `.claude/agents/`, `.opencode/agents/`, `.codex/agents/`, `.gemini/agents/`, `.github/agents/`, `.pi/agents/` and `pi-pi/`, `.claude/skills/`, `.opencode/skills/`, `.pi/skills/`, `.agents/skills`, `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/`, `.claude/references/`, `.claude/hooks/`). For each broken symlink, resolve where it pointed, look for a canonical replacement in the source `agents/` and `skills/` trees, and offer to repoint or delete. Common stale names from the pre-merge persona layout: `reviewer` → `code-reviewer`, `red-team` → `security-auditor`.

Also flag and offer to rewrite any YAML configs (`teams.yaml`, `agent-chain.yaml`, etc.) that still reference removed persona names.

Present findings as a `# | Path | Issue | Suggested fix` table and ask the user to pick which fixes to apply.

Never overwrite a regular file — only act on symlinks whose target is missing. Report `repaired`, `deleted`, and `skipped` counts, and append a `## doctor-runs` line to `.ai/agent-skills-setup.md` with the date, agent, phase (`standalone`), and counts.
