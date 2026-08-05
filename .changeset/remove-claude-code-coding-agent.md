---
"@chankov/agent-fleet": patch
---

Remove Claude Code as a coding-agent install target. pi is now the only agent the installer writes for; Claude Code stays in the fleet as a coms peer and nothing else.

**What is gone**

- `.claude/commands/` (15 slash commands, including `/orchestrate`) and `.claude/orchestrate-teams.yaml`
- `.claude-plugin/` — Agent Fleet is no longer published as a Claude Code plugin; npm is the only distribution channel
- `hooks/session-start.sh`, `hooks/simplify-ignore*.sh`, `hooks/SIMPLIFY-IGNORE.md`, `hooks/hooks.json` — all Claude-Code-runtime hooks
- `agent-fleet transform-persona` and `bin/lib/transform-persona.js`. Personas were only ever translated *for* Claude Code; `agents/*.md` is already pi's own dialect, so `bin/lib/personas.js` now just enumerates them and the install strategy is a plain `copy-file`
- The `transform-persona` install strategy, the `references-hooks` manifest group, and the interactive "which coding agent?" prompt

**What replaces it**

- `--agent` is still accepted and validated everywhere, but defaults to `pi` and is never asked for. `detectAgent()` has nothing left to detect
- References move from `.claude/references/` to `.pi/references/` and stop being a standalone menu section: each one is declared a **companion of the skills that cite it**, so installing `code-review-and-quality` brings `security-checklist.md` and `performance-checklist.md` with it, and uninstall refuses to strand a skill without its checklists
- A new `coms-bridge` manifest group holds the two halves of the Claude Code bridge — `skill:peer-coms` and `hook:coms-stop-hook`, the latter as a companion of the former. The hook still installs to `.claude/hooks/` under the **pi** agent, because the pane reading it is a Claude Code process. Registering it in `.claude/settings.json` remains a manual step, documented in `docs/claude-code-coms-bridge.md`

**Unchanged**

The bridge itself: `scripts/coms-claude-bridge.ts`, `scripts/lib/claude-bridge-core.ts`, `skills/peer-coms/`, the `_claude-peer` justfile recipe, `runner: claude-code` peers in `.pi/agents/peers.yaml`, and the `dispatch-policy.yaml` routing that lets a bridged pane serve an agent-hub team member's dispatch. Cross-model review through a standing Claude session works exactly as before.

**Upgrading.** A workspace previously installed for `claude-code` is not migrated automatically — its `.claude/` artifacts are no longer in the catalogue, so `verify` will not claim them and `uninstall` will not remove them. Re-run the guided setup (or `agent-fleet install --profile recommended`) to install for pi, then delete the leftover `.claude/` skills, commands, agents, and references by hand.
