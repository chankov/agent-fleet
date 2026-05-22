# Per-Project Skill Overrides

Some skills produce files or need facts that are specific to each project — where
specs and plans are saved, how to start a local dev server, whether the agent may
create git branches. Each such skill ships a sensible **default**. A project that
needs something different declares it once, in a single file, and the skill picks
it up.

## The override file

Create `.ai/agent-skills-overrides.md` in the **target project** (the repo being
worked on — not in agent-skills itself). Skills read this file before producing
output. If the file is absent, or a skill has no section in it, the skill uses its
built-in default.

- **Location:** `.ai/agent-skills-overrides.md` at the project root.
- **Format:** Markdown. One `## <skill-name>` section per skill, with `key: value`
  lines inside it. Block values use the `key: |` multi-line form.
- **Commit it.** The override file is shared project configuration and belongs in
  version control. Make sure no `.gitignore` rule (for example a broad `.env*`
  pattern) silently excludes it.
- **No secrets.** Never put passwords, tokens, or keys in this file. For anything
  sensitive (test-account credentials), reference the **name** of an environment
  variable; the real value lives in a gitignored `.env`.

## Skills that read overrides

### `spec-driven-development`

| Key | Default | Meaning |
|-----|---------|---------|
| `spec-dir` | `docs/prds/{area}` | Directory specs are written to |
| `naming` | `PRD{n}-{topic}` | File name pattern; `{n}` = next free PRD number, `{topic}` = kebab-case slug |

Default output: `docs/prds/{area}/PRD{n}-{topic}.md`.

### `planning-and-task-breakdown`

| Key | Default | Meaning |
|-----|---------|---------|
| `plan-dir` | `docs/plans/{area}` | Directory plans are written to |
| `naming` | `PLAN-{prd-name}-{phase}` | File name pattern; `{phase}` suffix only when a plan spans multiple files |
| `todo` | `embedded` | `embedded` keeps the task list inside the plan; `separate` writes a standalone `todo.md` |

Default output: `docs/plans/{area}/PLAN-{prd-name}-{phase}.md`, task list embedded.

### `browser-testing-with-devtools`

This skill has **no default** — the section is required for browser testing,
because dev-server commands and login flows cannot be guessed.

| Key | Meaning |
|-----|---------|
| `dev-server` | Command to start the local dev server |
| `ready-check` | How to confirm the server is up |
| `base-url` | Root URL for navigation |
| `auth-flow` | Steps to log in (multi-line `|` block) |
| `roles` | Test account per privilege level, referenced by env-var name |
| `notes` | Anything else the agent should know (certs, seed data, ...) |

### `git-workflow-and-versioning`

| Key | Default | Meaning |
|-----|---------|---------|
| `branching` | `never` | `never` = agent works in the current branch and never creates or switches branches; `allow` = agent may create feature branches |

## Template

Copy this into `.ai/agent-skills-overrides.md` and delete the sections you don't
need — anything absent falls back to the skill default.

```markdown
# Agent Skills — Project Overrides
#
# Skills read this file and apply each section ON TOP of their built-in defaults.
# Keys not listed keep the default. Absent file/section → pure defaults.

## spec-driven-development
spec-dir: docs/prds/{area}
naming:   PRD{n}-{topic}

## planning-and-task-breakdown
plan-dir: docs/plans/{area}
naming:   PLAN-{prd-name}-{phase}
todo:     embedded

## browser-testing-with-devtools
dev-server:  <command to start the local dev server>
ready-check: <url or check that confirms the server is up>
base-url:    <root url>
auth-flow: |
  1. Navigate to <login url>
  2. Submit credentials for the role needed by the screen under test
roles:
  admin:  env APP_TEST_ADMIN_USER / APP_TEST_ADMIN_PASS
  player: env APP_TEST_PLAYER_USER / APP_TEST_PLAYER_PASS
notes: |
  <anything else: self-signed certs, required seed data, ...>

## git-workflow-and-versioning
branching: never
```
