# Agent Skills — Project Files

agent-skills keeps up to two small files in a project's `.ai/` directory. They
have different readers and different lifetimes, so they are kept separate.

| File | Read by | When |
|------|---------|------|
| `.ai/agent-skills-overrides.md` | `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`, `agent-hub` pi harness | Every run of those skills / every session start of the harness |
| `.ai/agent-skills-setup.md` | `guided-workspace-setup` | Only when setup is run or re-run |

Keep them split: the overrides file is loaded into context constantly, so it
must stay minimal; the install record is consulted rarely, so it can be large.

## The overrides file — `.ai/agent-skills-overrides.md`

Some skills and pi harnesses need facts specific to each project — where specs
and plans are saved, how to start a dev server, whether the agent may create
branches, or which user-facing language a dispatcher should use. Each reader
ships a sensible **default**; a project that needs something different declares
it here, and the reader picks it up.

- **Location:** `.ai/agent-skills-overrides.md` at the project root.
- **Format:** Markdown. One `## <section-name>` section per skill or harness reader, with terse
  `key: value` lines. Block values use the `key: |` multi-line form. No prose
  and no install detail — readers parse it by key and load it on every run/session start.
- **Commit it.** Shared project configuration belongs in version control. Make
  sure no `.gitignore` rule (for example a broad `.env*` pattern) excludes it.
- **No secrets.** For anything sensitive (test-account credentials), reference
  the **name** of an environment variable; the real value lives in a gitignored
  `.env`.
- If the file is absent, or a reader has no section in it, that reader uses its
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

### `agent-hub` (legacy `## agent-team` override section)

Read by the `.pi/harnesses/agent-hub/` pi harness on every session start. The override section name remains
`## agent-team` for compatibility with existing project override files while the standalone
`agent-team` harness is retired.

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `English` | User-facing language the dispatcher uses for every `ask_user` question, every `context` field, and every summary. Specialist task strings always stay in English regardless. |
| `persona-gate` | `off` | When `on`, blocks input at session start until an orchestrator persona is picked. |
| `model.<persona>` | persona frontmatter `model:` | Replaces the named persona's default model for this project (a full pi model spec). |
| `models.<persona>` | persona frontmatter `models:` | Replaces the named persona's model-candidate list for `/agent-model` and `/models` profiles (comma-separated pi model specs). |
| `subagents.<persona>.<role>` | persona frontmatter `subagents:` | Replaces or adds one delegate sub-role for this project: `<model>[, tools=<caps>]`. Other declared roles keep their frontmatter values. |
| `delegate-depth.<persona>` | persona frontmatter `delegate_depth:` (default 1) | Replaces the persona's delegation depth budget: `0` makes its delegate tool refuse (delegation off for this project), `2` lets its children delegate one level further. |

Example — switch the dispatcher to Bulgarian, pin the builder to sonnet, and move
the code-reviewer's docs sub-reviewer to a different model for this project:

```markdown
## agent-team
language: Bulgarian
model.builder: github-copilot/claude-sonnet-4.6
models.builder: github-copilot/claude-sonnet-4.6, github-copilot/claude-haiku-4.5
subagents.code-reviewer.docs: github-copilot/claude-sonnet-4.6, tools=read,grep
delegate-depth.code-reviewer: 2
```

## The setup file — `.ai/agent-skills-setup.md`

The `guided-workspace-setup` skill writes this file to record what it installed
into the project — which skills, commands, personas, and extensions, by what
method, and when. It reads the file on a re-run to add, update, or remove
artifacts without reinstalling everything. No other skill loads it.

| Section | Meaning |
|---------|---------|
| `workspace-summary` | Workspace path, coding agent, **agent-skills version**, project shape, checks discovered |
| `install-status` | Installed artifacts, their targets, and the method (`copy` or `symlink`) |
| `doctor-runs` | One line per doctor pass (preflight / postflight, repaired / deleted / skipped counts) |
| `verification` | Checks confirming the install |

### The `version:` line

`workspace-summary` carries a `version:` line set to the package version that
performed the install (e.g. `version: 1.4.2`). It drives the version-aware
update flow — on every re-run, `guided-workspace-setup` compares this against
the current package version and:

1. Reads `CHANGELOG.md` between the two versions.
2. For each installed artifact, runs a three-way diff between
   *source@recorded*, the installed copy on disk, and *source@current*.
3. Surfaces the result in the install menu using these `Status` values:

| Status | Meaning |
|---|---|
| `installed · upgrade available` | Source changed upstream; user copy still matches the old source → clean refresh |
| `installed · conflicting upgrade` | Source changed upstream AND user modified the copy → menu shows the three-way diff before overwriting |
| `installed · removed upstream` | Artifact gone in the new version → menu proposes deletion (subject to the removal-scope rule) |
| `not installed · new in this version` | New artifact added in the new version → menu offers it, marked `★` if recommended |

The diff sources at *source@recorded* are read from the package's
`.versions/<x.y.z>/` snapshot tree, which the release pipeline writes for every
published version. If the snapshot is missing (e.g. an unpublished local
build), the skill falls back to "treat installed copy as canonical" and
prompts for an explicit baseline.

### Pre-versioning workspaces

A workspace whose `agent-skills-setup.md` predates the `version:` line is
treated as "pre-versioning". On first re-run, `guided-workspace-setup` prompts
for a clean baseline: either accept the installed artifacts as matching the
current source (stamp the current version), or re-run the install from scratch.

Commit this file if the team should share install state — keep paths relative
so it stays portable. A self-referencing checkout (agent-skills itself) may
instead `.gitignore` it, since its recorded paths are local to one machine.

## Templates

### `.ai/agent-skills-overrides.md`

Copy this in and delete the sections you don't need — anything absent falls
back to that reader's default.

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

# Optional for pi agent-hub; omit this section to keep default English.
## agent-team
language: <language name>
```

### `.ai/agent-skills-setup.md`

Written and maintained by `guided-workspace-setup`; shown here for reference.

```markdown
# Agent Skills — Workspace Setup
#
# Maintained by the guided-workspace-setup skill.

## workspace-summary
agent:   claude-code
method:  copy
version: 1.4.2
shape:   <one line on the project shape>

## install-status
skills:     [spec-driven-development, test-driven-development, code-review-and-quality]
commands:   [spec, plan, build]
personas:   [code-reviewer]
extensions: []
harnesses:  []
harness-support: []   # justfile (managed region) + scripts/agents companions; tracked when any harness is installed
updated:    2026-05-22

## verification
- Every recorded artifact exists at its target path.
- No secrets are stored in this file.
```
