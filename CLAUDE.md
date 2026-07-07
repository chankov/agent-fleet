# agent-skills

This is the agent-skills project — a collection of production-grade engineering skills for AI coding agents.

## Project Structure

```
bin/          → npm CLI: cli.js (agent-skills entrypoint), lib/{doctor,detect-agent,transform-persona}.js, test/ (node --test), snapshot-version.js
skills/       → Core skills (SKILL.md per directory)
agents/       → 13 reusable agent personas, canonical pi-flavored frontmatter; installed per agent via `transform-persona` (claude-code/opencode get generated copies; bowser + orchestrator are pi-only)
hooks/        → Session lifecycle hooks
scripts/      → Standalone scripts (team-up herdr launcher for reusable coms peers; scripts/lib/ pure fleet modules under node --test)
justfile      → Recipes to launch pi with each harness
.changeset/   → Pending changesets; rolled into CHANGELOG.md + version bump by `changeset version`
.versions/    → Per-version artifact snapshots used by the version-aware update flow (snapshot-version.js)
.github/workflows/release.yml → On merge to main: opens "Version Packages" PR or runs `changeset publish`
.claude/commands/ → Claude Code slash commands (/spec, /plan, /build, /test, /review, /orchestrate, /compound, /code-simplify, /ship, /design-agent, /prime, /setup-agent-skills)
.claude/orchestrate-teams.yaml → named-team roster read by /orchestrate (mirrors .pi/agents/teams.yaml); companion installed with the command; opencode copy at .opencode/orchestrate-teams.yaml
.opencode/commands/ → OpenCode slash commands, `as-` prefixed mirror of .claude/commands/ (includes as-orchestrate, as-compound) — keep in sync. /orchestrate and /compound ship for claude-code + opencode only; pi orchestrates via the agent-hub harness, which provides its own /compound command
.pi/prompts/  → pi-native lifecycle prompt templates
.pi/extensions/ → always-on pi utility extensions, auto-discovered by pi (mcp-bridge, chrome-devtools-mcp, compact-and-continue, btw, agent-skills-update-check, pi-voice-stt). pi-voice-stt is gated/optional — it binds its Alt+S hotkey only when an STT provider is configured, otherwise it is a no-op
.pi/harnesses/ → selectable pi session harnesses — NOT auto-discovered; loaded explicitly via the justfile or `pi -e` (`just hub` stacks damage-control-continue before agent-hub for the main agent; spawned specialists get hard-stop damage-control, research helpers get damage-control-continue)
.pi/agents/   → pi YAML configs (teams, chains, peers, dispatch-policy) used by the orchestration harnesses; dispatch-policy.yaml routes dispatch_agent calls to same-name coms peers (e.g. the claude-code reviewers) with native fallback
.pi/skills/   → pi-runtime skills (e.g. bowser browser automation)
.pi/damage-control-rules.yaml → rule set for the damage-control harness
references/   → Supplementary checklists (testing, performance, security, accessibility, observability)
docs/         → Setup guides, agent-skills-setup.md (per-project overrides + install-record convention), npm-install.md (CLI + versioning), claude-code-coms-bridge.md (Claude Code as a coms peer), plus pi-extensions.md and pi-specs/ for the pi extensions
FORK.md       → Canonical record of how this fork differs from upstream addyosmani/agent-skills: fork-vs-upstream pitch, the added/dropped/adapted tables, the upstream-merge reconciliation playbook, and the decision log. UPDATE IT in any change that alters fork direction — especially after every upstream merge.
```

## Skills by Phase

**Define:** interview-me, idea-refine, spec-driven-development
**Plan:** planning-and-task-breakdown
**Build:** incremental-implementation, test-driven-development, context-engineering, source-driven-development, doubt-driven-development, frontend-ui-engineering, api-and-interface-design
**Verify:** browser-testing-with-devtools, debugging-and-error-recovery
**Review:** code-review-and-quality, code-simplification, security-and-hardening, performance-optimization
**Ship:** git-workflow-and-versioning, ci-cd-and-automation, deprecation-and-migration, documentation-and-adrs, observability-and-instrumentation, shipping-and-launch
**Orchestrate:** orchestration-verification (the Verification Contract enforced by the `orchestrator` persona + agent-hub harness), peer-coms (Claude Code as a coms peer via the bridge — see docs/claude-code-coms-bridge.md)
**Learn:** compound-learning (end-of-session lessons → minimal diffs on the project's `rules:`/`docs:` targets, via `/compound` on claude-code/opencode or the agent-hub `/compound` command dispatching `documenter`)
**Onboard:** guided-workspace-setup

## Conventions

- Every skill lives in `skills/<name>/SKILL.md`
- YAML frontmatter with `name` and `description` fields
- Description starts with what the skill does (third person), followed by trigger conditions ("Use when...")
- Every skill has: Overview, When to Use, Process, Common Rationalizations, Red Flags, Verification
- References are in `references/`, not inside skill directories
- Supporting files only created when content exceeds 100 lines
- Override readers ship built-in defaults but read per-project overrides from `.ai/agent-skills-overrides.md` in the *target* project — see `docs/agent-skills-setup.md`:
  - Skills: `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`
  - pi harness: `agent-hub` via the `## agent-hub` section (legacy `## agent-team` still accepted)
  - pi extension: `pi-voice-stt` reads project-local `.ai/stt.json` (its own JSON config, not the overrides markdown) ahead of global `~/.pi/agent/stt.json`; guided setup writes it + the gitignored `.env` secrets
- Always-on pi utility extensions live in `.pi/extensions/<name>/` (auto-discovered by pi); the selectable orchestration/UI/safety/messaging harnesses live in `.pi/harnesses/<name>/` (NOT auto-discovered — loaded explicitly via the `justfile` or `pi -e`; `just hub` stacks `damage-control-continue` before `agent-hub` for the main agent, and `agent-hub` re-loads hard-stop `damage-control` into spawned specialists / `damage-control-continue` into research helpers). Each is a directory with `index.ts` + `package.json` + `README.md`. Never put a harness under `.pi/extensions/` — pi loads everything there at once. The harnesses are ported from disler/pi-vs-claude-code (MIT) — see `docs/pi-extensions.md`

## Commands

- `npm test` — CLI smoke test (`--version`, `--help`, `transform-persona --list`) plus the `node --test` unit tests in `bin/test/`
- `node bin/cli.js transform-persona --agent <a> [--list|--all|names…]` — Generate per-agent persona files from `agents/*.md`; the mapping lives in `bin/lib/transform-persona.js`, under test — never transform persona frontmatter by hand
- `npm run pack:dry` — `npm pack --dry-run` to verify the tarball contents match `package.json`'s `files` allowlist
- `npx changeset` — Add a changeset for any user-visible change (see CONTRIBUTING.md for bump rules)
- `node bin/snapshot-version.js` — Build the `.versions/<x.y.z>/` snapshot manually (the release workflow runs this automatically)
- Validate: Check that all SKILL.md files have valid YAML frontmatter with name and description

## Boundaries

- Always: Follow the skill-anatomy.md format for new skills
- Never: Add skills that are vague advice instead of actionable processes
- Never: Duplicate content between skills — reference other skills instead
