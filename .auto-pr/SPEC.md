# Spec — Issue #135: Empty scripts/ directories create inconsistency

> Source: https://github.com/addyosmani/agent-skills/issues/135

## Problem

Contributor docs explain the required `SKILL.md` file and optional supporting files, but they never state plainly that a `scripts/` directory is optional and should only exist when a skill ships runnable helpers. That gap makes the template feel stricter than it is and encourages contributors to create empty `scripts/` directories just to match the example shape.

## Acceptance criteria

- [ ] Contributor docs explicitly say `scripts/` is optional and should only be added when the skill includes runnable helpers.
- [ ] Contributor docs explicitly discourage empty `scripts/` directories.
- [ ] The skill template in `AGENTS.md` makes the `Usage` / script section conditional rather than implied for every skill.

## Approach

Clarify the docs instead of deleting directories. Add a short explicit rule to `docs/skill-anatomy.md`, reinforce it in `CONTRIBUTING.md`, and update the `AGENTS.md` scaffold so contributors understand that script-backed skills and markdown-only skills are both valid patterns.

## Files likely touched

- `docs/skill-anatomy.md` — clarify that `scripts/` is optional and should not be empty
- `CONTRIBUTING.md` — reinforce the same rule in contributor-facing guidance
- `AGENTS.md` — adjust the skill template so the script usage section is optional

## Risk / blast radius

- **Scope**: small
- **Breaking**: no
- **Migration needed**: no

## Test plan

- **Unit**: n/a
- **Integration**: `rg` checks for explicit optional-scripts wording and `git diff --check`
- **Visual**: n/a

## Out of scope

- Removing or restructuring any existing skill directories
- Creating new scripts for markdown-only skills
