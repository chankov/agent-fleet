# Skill Anatomy

This document describes the structure and format of swe-skills skill files. Use this as a guide when contributing new skills or understanding existing ones.

## File Location

Every skill lives in its own directory under `skills/`:

```
skills/
  skill-name/
    SKILL.md          # Required: The skill definition
    supporting-file.md # Optional: Reference material loaded on demand
```

## SKILL.md Format

### Frontmatter (Required)

```yaml
---
name: skill-name-with-hyphens
description: Use when [specific triggering conditions]. Use when [additional triggers].
---
```

**Rules:**
- `name`: Lowercase, hyphen-separated. Must match the directory name.
- `description`: Starts with "Use when". Describes triggering conditions only — never summarizes the workflow. Under 500 characters.

**Why this matters:** Agents discover skills by reading descriptions. If the description summarizes the workflow, the agent may follow the summary instead of reading the full skill.

### Standard Sections

```markdown
# Skill Title

## Overview
One-two sentences explaining what this skill does and why it matters.

## When to Use
- Bullet list of triggering conditions (symptoms, task types)
- When NOT to use (exclusions)

## [Core Process / The Workflow / Steps]
The main workflow, broken into numbered steps or phases.
Include code examples where they help.
Use flowcharts (ASCII) where decision points exist.

## [Specific Techniques / Patterns]
Detailed guidance for specific scenarios.
Code examples, templates, configuration.

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| Excuse agents use to skip steps | Why the excuse is wrong |

## Red Flags
- Behavioral patterns indicating the skill is being violated
- Things to watch for during review

## Verification
After completing the skill's process, confirm:
- [ ] Checklist of exit criteria
- [ ] Evidence requirements
```

## Section Purposes

### Overview
The "elevator pitch" for the skill. Should answer: What does this skill do, and why should an agent follow it?

### When to Use
Helps agents and humans decide if this skill applies to the current task. Include both positive triggers ("Use when X") and negative exclusions ("NOT for Y").

### Core Process
The heart of the skill. This is the step-by-step workflow the agent follows. Must be specific and actionable — not vague advice.

**Good:** "Run `npm test` and verify all tests pass"
**Bad:** "Make sure the tests work"

### Common Rationalizations
The most distinctive feature of well-crafted skills. These are excuses agents use to skip important steps, paired with rebuttals. They prevent the agent from rationalizing its way out of following the process.

Think of every time an agent has said "I'll add tests later" or "This is simple enough to skip the spec" — those go here with a factual counter-argument.

### Red Flags
Observable signs that the skill is being violated. Useful during code review and self-monitoring.

### Verification
The exit criteria. A checklist the agent uses to confirm the skill's process is complete. Every checkbox should be verifiable with evidence (test output, build result, screenshot, etc.).

## Supporting Files

Create supporting files only when:
- Reference material exceeds 100 lines (keep the main SKILL.md focused)
- Code tools or scripts are needed
- Checklists are long enough to justify separate files

Keep patterns and principles inline when under 50 lines.

## Writing Principles

1. **Process over knowledge.** Skills are workflows, not reference docs. Steps, not facts.
2. **Specific over general.** "Run `npm test`" beats "verify the tests".
3. **Evidence over assumption.** Every verification checkbox requires proof.
4. **Anti-rationalization.** Every skip-worthy step needs a counter-argument in the rationalizations table.
5. **Progressive disclosure.** Main SKILL.md is the entry point. Supporting files are loaded only when needed.
6. **Token-conscious.** Every section must justify its inclusion. If removing it wouldn't change agent behavior, remove it.

## Naming Conventions

- Skill directories: `lowercase-hyphen-separated`
- Skill files: `SKILL.md` (always uppercase)
- Supporting files: `lowercase-hyphen-separated.md`
- References: stored in `references/` at the project root, not inside skill directories

## Cross-Skill References

Reference other skills by name:

```markdown
Follow the `test-driven-development` skill for writing tests.
If the build breaks, use the `debugging-and-error-recovery` skill.
```

Don't duplicate content between skills — reference and link instead.
