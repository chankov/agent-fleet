# Agent Skills — Project Files

agent-skills keeps up to two small files in a project's `.ai/` directory. They
have different readers and different lifetimes, so they are kept separate.

| File | Read by | When |
|------|---------|------|
| `.ai/agent-skills-overrides.md` | `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning` | Every run of those skills |
| `.ai/agent-skills-setup.md` | `guided-workspace-setup` | Only when setup is run or re-run |

Keep them split: the overrides file is loaded into context constantly, so it
must stay minimal; the install record is consulted rarely, so it can be large.

## The overrides file — `.ai/agent-skills-overrides.md`

Some skills produce files or need facts specific to each project — where specs
and plans are saved, how to start a dev server, whether the agent may create
branches. Each ships a sensible **default**; a project that needs something
different declares it here, and the skill picks it up.

- **Location:** `.ai/agent-skills-overrides.md` at the project root.
- **Format:** Markdown. One `## <skill-name>` section per skill, with terse
  `key: value` lines. Block values use the `key: |` multi-line form. No prose
  and no install detail — skills parse it by key and load it on every run.
- **Commit it.** Shared project configuration belongs in version control. Make
  sure no `.gitignore` rule (for example a broad `.env*` pattern) excludes it.
- **No secrets.** For anything sensitive (test-account credentials), reference
  the **name** of an environment variable; the real value lives in a gitignored
  `.env`.
- If the file is absent, or a skill has no section in it, the skill uses its
  built-in default.

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

## The setup file — `.ai/agent-skills-setup.md`

The `guided-workspace-setup` skill writes this file to record what it installed
into the project — which skills, commands, personas, and extensions, by what
method, and when. It reads the file on a re-run to add, update, or remove
artifacts without reinstalling everything. No other skill loads it.

| Section | Meaning |
|---------|---------|
| `workspace-summary` | Workspace path, coding agent, project shape, checks discovered |
| `install-status` | Installed artifacts, their targets, and the method (`copy` or `symlink`) |
| `verification` | Checks confirming the install |

Commit this file if the team should share install state — keep paths relative
so it stays portable. A self-referencing checkout (agent-skills itself) may
instead `.gitignore` it, since its recorded paths are local to one machine.

## Templates

### `.ai/agent-skills-overrides.md`

Copy this in and delete the sections you don't need — anything absent falls
back to the skill default.

```markdown
# Agent Skills — Project Overrides
#
# Each section is applied ON TOP of the skill's built-in defaults.
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

### `.ai/agent-skills-setup.md`

Written and maintained by `guided-workspace-setup`; shown here for reference.

```markdown
# Agent Skills — Workspace Setup
#
# Maintained by the guided-workspace-setup skill.

## workspace-summary
agent:  claude-code
method: copy
shape:  <one line on the project shape>

## install-status
skills:     [spec-driven-development, test-driven-development, code-review-and-quality]
commands:   [spec, plan, build]
personas:   [code-reviewer]
extensions: []
harnesses:  []
updated:    2026-05-22

## verification
- Every recorded artifact exists at its target path.
- No secrets are stored in this file.
```
