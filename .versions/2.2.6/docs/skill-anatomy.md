# Skill Anatomy

Use this guide to create, update, and distribute Agent Fleet skills.

## File Location

Put Fleet-native skills in their own directories under `skills/`.

```text
skills/
  skill-name/
    SKILL.md           # Required skill definition
    scripts/           # Optional runnable helpers
    supporting-file.md # Optional material loaded on demand
```

`SKILL.md` is the only required file. A Markdown-only skill is complete with
that file alone. Check [native-first discovery](UPSTREAM-SKILLS.md#layout-and-precedence)
before adding a skill name that already exists upstream.

## SKILL.md Format

### Frontmatter (Required)

```yaml
---
name: skill-name-with-hyphens
description: Guides agents through [task/workflow]. Use when [specific trigger conditions].
---
```

- Use a lowercase, hyphen-separated `name` that matches the directory name.
- Start the `description` with what the skill does in third person, then give
  clear “Use when” triggers. Keep it within 1024 characters.

Agents see the description at discovery and load the full workflow on demand.
Keep process steps in the body so agents read the workflow when they use it.

### Standard Sections (Recommended Pattern)

Use this layout as a starting point. Equivalent headings such as “How It
Works”, “Core Process”, or “Workflow” are welcome when they serve the same purpose.

```markdown
# Skill Title

## Overview
Explain what the skill does and why it matters in one or two sentences.

## When to Use
List triggers and exclusions that help an agent identify when the skill applies.

## Workflow
Number the steps and name the commands, decisions, or outputs for each one.
Use a diagram for branching decisions when it helps.

## Usage
Give commands, arguments, and examples when the skill includes runnable helpers.

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| “I'll add tests later.” | Write the failing test first so it proves the fix. |

## Red Flags
Describe observable signs that the skill's workflow has been skipped or misapplied.

## Verification
- [ ] Check each exit criterion using a concrete result such as a passing test or build output.

## Output and Troubleshooting
Include a result example or reporting template and recovery steps where helpful.
```

## Supporting Files

Keep `SKILL.md` focused and aim for fewer than 500 lines. Link supporting
files directly from it with relative paths and say when to read each file.
Keep short patterns inline and move substantial examples or checklists to a
supporting file. Put references shared across skills in `references/`.

Add `scripts/` when the skill includes runnable helpers. Give Bash helpers a
kebab-case `.sh` filename, a `#!/bin/bash` shebang, and fail-fast handling with
`set -e`. Use stderr for status messages, stdout for machine-readable results,
and a cleanup trap when a script creates temporary files. Show the command
and working directory in the skill's usage section.

## Writing Principles

- Base the workflow on real work. Use concrete steps, such as running the
  relevant tests and checking their exit code.
- Give each step that agents tend to skip a factual counter-argument. Specify
  the evidence needed to finish, such as test output or a runtime observation.
- Keep each section focused on what the agent needs to act. Name other skills
  by their `name` when they already cover part of the work.
- Review [prompting patterns](../references/prompting-patterns.md) before
  finalizing the skill. Use positive instructions and explain the reason for
  non-obvious rules.

## Installation and distribution

For managed Pi workspaces, use `npx @chankov/agent-fleet@latest setup` with the
applicable preset or named feature. See [installation and lifecycle](npm-install.md)
and [package-native Pi setup](pi-setup.md#package-native-skills-and-prompts).
For a standalone manual Pi install, copy the skill directory to `.pi/skills/`
in the workspace and include the dependencies it references.

Regenerate the install manifest with `npm run build:manifest` when skill
catalog entries change. Keep `pi.skills` aligned with the native-first winners
and run the catalog checks. See [upstream maintenance](UPSTREAM-SKILLS.md#update-procedure).

### ZIP archives

Ship a ZIP only for a skill with an archive distribution channel. Keep
`skills/<skill-name>.zip` next to its source directory with `<skill-name>/`
as the archive's top-level directory. Build a fresh archive after changing
its source so that deleted files are also removed from the ZIP.

```bash
# From the repository root, replace <skill-name> with the directory name.
(
  set -e
  skill='<skill-name>'
  archive_dir=$(mktemp -d)
  trap 'rm -f "$archive_dir/$skill.zip"; rmdir "$archive_dir"' EXIT
  (cd skills && zip -r "$archive_dir/$skill.zip" "$skill/" -x '*/.DS_Store')
  mv "$archive_dir/$skill.zip" "skills/$skill.zip"
  node --test bin/test/skill-archives.test.js
)
```

The archive test compares the file list and contents of each checked-in ZIP
with its source directory.
