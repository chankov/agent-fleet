---
"@chankov/agent-skills": minor
---

Personas are now installable for every supported coding agent, with deterministic per-agent transformation:

- New `agent-skills transform-persona` CLI subcommand (backed by `bin/lib/transform-persona.js`, under `node --test` coverage) generates per-agent subagent files from the canonical `agents/*.md`: Claude Code gets `.claude/agents/<name>.md` with tools/model translated (`read→Read`, `find/ls→Glob`, `claude-opus-*→opus`, …), OpenCode gets `.opencode/agent/<name>.md` with `mode: subagent` + tool denials, pi gets the canonical file unchanged. Agent-hub-only frontmatter (`models`, `thinking`, `delegate_depth`, `subagents`, `kind`, `skills`) never leaks into transformed output.
- `/setup-agent-skills` now offers the **full persona roster** per agent (was a hardcoded 7): all 14 for pi; 11 for claude-code/opencode (`bowser`, `orchestrator`, `orchestrator-careful` are pi-only). Transformed installs are always generated copies — even in symlink mode — recorded with `transformed: true` and diffed against generated output on re-runs.
- README: full 14-persona table with access level, primary-skill mapping, and per-agent availability, plus new sections on how personas connect to skills and how to compose them into subagent teams (pi agent-hub teams/peers, Claude Code subagents, OpenCode `@`-mentions).
- **Removed** support surfaces for Cursor, Gemini CLI, Windsurf, GitHub Copilot, and Codex: their `docs/*-setup.md` guides and README install sections are gone, and the doctor no longer scans `.codex/agents/`, `.gemini/agents/`, or `.github/agents/` (it now also scans `.opencode/agent/`, and repairs broken persona links under `.claude/agents/` / `.opencode/agent(s)/` by regenerating transformed copies instead of re-symlinking the raw source). If you followed one of the deleted guides, the skills remain plain Markdown and still work — but the repo no longer documents or maintains those paths.
