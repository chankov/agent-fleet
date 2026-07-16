---
"@chankov/agent-fleet": minor
---

Agent Fleet split: standalone repository, vendored upstream skills, full rebrand.

- Repository split from the `agent-skills` fork into standalone `chankov/agent-fleet` with filtered history; upstream `addyosmani/agent-skills` is now consumed as manually vendored content in `vendor/agent-skills-upstream/` at a pinned SHA (see `docs/UPSTREAM-SKILLS.md`).
- Package renamed `@chankov/agent-skills` → `@chankov/agent-fleet`; CLI bin `agent-skills` → `agent-fleet` (no alias); commands `/setup-agent-skills` → `/setup-agent-fleet`, `/doctor-agent-skills` → `/doctor-agent-fleet`; OpenCode prefix `as-*` → `af-*`; install record `.ai/agent-skills-setup.md` → `.ai/agent-fleet-setup.md`; overrides file `.ai/agent-skills-overrides.md` → `.ai/agent-fleet-overrides.md`; update-check extension renamed `agent-fleet-update-check`.
- Skill discovery now spans two roots (native `skills/` wins over the vendored import on name collisions) across pi packaging, the guided setup, the doctor scan, and the Claude Code plugin manifest.
- `FORK.md` retired; replaced by `docs/ARCHITECTURE.md`, `docs/UPSTREAM-SKILLS.md`, and `docs/MIGRATION-agent-fleet.md`.
- Workspaces installed by `@chankov/agent-skills` are not auto-detected — re-run `npx @chankov/agent-fleet init`.
