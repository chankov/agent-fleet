---
"@chankov/agent-fleet": patch
---

Restore four reference documents that a docs cleanup removed by mistake, and guard the allowlist against the next one.

`docs/MIGRATION-agent-fleet.md`, `docs/claude-code-coms-bridge.md`, `docs/coms-hermes-bridge.md` and `docs/codex-session-bridge.md` are part of the published surface — all four are named in `package.json`'s `files` allowlist — but they were deleted alongside a batch of genuinely obsolete planning drafts. `npm pack` ships nothing for an allowlist entry that matches no file and says nothing about it, so the loss surfaced only as two failing tests and 26 dangling links across the README, `CLAUDE.md`, `AGENTS.md` and the docs tree.

The restored copies predate the `.pi/` runtime relocation, so they carry the same path rewrite the surviving docs already got: runtime scripts under `.pi/agent-fleet/scripts/`, and the coms-bridge Stop hook at `.pi/agent-fleet/hooks/coms-stop-hook.mjs` rather than `.claude/hooks/`.

Two guards now cover the failure mode: every literal markdown entry in the `files` allowlist must exist on disk, and every relative link in the public docs must resolve.
