# agent-skills

This is the agent-skills project — a collection of production-grade engineering skills for AI coding agents.

## Project Structure

```
bin/          → npm CLI: cli.js (agent-skills entrypoint), lib/{doctor,detect-agent}.js, snapshot-version.js
skills/       → Core skills (SKILL.md per directory)
agents/       → Reusable agent personas (code-reviewer, test-engineer, security-auditor)
hooks/        → Session lifecycle hooks
scripts/      → Standalone scripts (coms-net hub server for the coms-net pi extension)
justfile      → Recipes to launch pi with each harness
.changeset/   → Pending changesets; rolled into CHANGELOG.md + version bump by `changeset version`
.versions/    → Per-version artifact snapshots used by the version-aware update flow (snapshot-version.js)
.github/workflows/release.yml → On merge to main: opens "Version Packages" PR or runs `changeset publish`
.claude/commands/ → Claude Code slash commands (/spec, /plan, /build, /test, /review, /code-simplify, /ship, /design-agent, /prime, /setup-agent-skills)
.opencode/commands/ → OpenCode slash commands, `as-` prefixed mirror of .claude/commands/ — keep in sync
.pi/prompts/  → pi-native lifecycle prompt templates
.pi/extensions/ → always-on pi utility extensions, auto-discovered by pi (mcp-bridge, chrome-devtools-mcp, compact-and-continue)
.pi/harnesses/ → selectable pi session harnesses — NOT auto-discovered; loaded one at a time via the justfile or `pi -e`
.pi/agents/   → pi agent personas, teams, and chains used by the orchestration harnesses
.pi/skills/   → pi-runtime skills (e.g. bowser browser automation)
.pi/damage-control-rules.yaml → rule set for the damage-control harnesses
references/   → Supplementary checklists (testing, performance, security, accessibility)
docs/         → Setup guides, agent-skills-setup.md (per-project overrides + install-record convention), npm-install.md (CLI + versioning), plus pi-extensions.md and pi-specs/ for the pi extensions
```

## Skills by Phase

**Define:** spec-driven-development
**Plan:** planning-and-task-breakdown
**Build:** incremental-implementation, test-driven-development, context-engineering, source-driven-development, frontend-ui-engineering, api-and-interface-design
**Verify:** browser-testing-with-devtools, debugging-and-error-recovery
**Review:** code-review-and-quality, code-simplification, security-and-hardening, performance-optimization
**Ship:** git-workflow-and-versioning, ci-cd-and-automation, deprecation-and-migration, documentation-and-adrs, shipping-and-launch
**Onboard:** guided-workspace-setup

## Conventions

- Every skill lives in `skills/<name>/SKILL.md`
- YAML frontmatter with `name` and `description` fields
- Description starts with what the skill does (third person), followed by trigger conditions ("Use when...")
- Every skill has: Overview, When to Use, Process, Common Rationalizations, Red Flags, Verification
- References are in `references/`, not inside skill directories
- Supporting files only created when content exceeds 100 lines
- Skills that produce files or need project-specific facts (`spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`) ship built-in defaults but read per-project overrides from `.ai/agent-skills-overrides.md` in the *target* project — see `docs/agent-skills-setup.md`
- Always-on pi utility extensions live in `.pi/extensions/<name>/` (auto-discovered by pi); the selectable orchestration/UI/safety/messaging harnesses live in `.pi/harnesses/<name>/` (NOT auto-discovered — loaded one at a time via the `justfile` or `pi -e`). Each is a directory with `index.ts` + `package.json` + `README.md`. Never put a harness under `.pi/extensions/` — pi loads everything there at once. The harnesses are ported from disler/pi-vs-claude-code (MIT) — see `docs/pi-extensions.md`

## Commands

- `npm test` — Runs `node bin/cli.js --version && node bin/cli.js --help` as a basic CLI smoke test
- `npm run pack:dry` — `npm pack --dry-run` to verify the tarball contents match `package.json`'s `files` allowlist
- `npx changeset` — Add a changeset for any user-visible change (see CONTRIBUTING.md for bump rules)
- `node bin/snapshot-version.js` — Build the `.versions/<x.y.z>/` snapshot manually (the release workflow runs this automatically)
- Validate: Check that all SKILL.md files have valid YAML frontmatter with name and description

## Boundaries

- Always: Follow the skill-anatomy.md format for new skills
- Never: Add skills that are vague advice instead of actionable processes
- Never: Duplicate content between skills — reference other skills instead
