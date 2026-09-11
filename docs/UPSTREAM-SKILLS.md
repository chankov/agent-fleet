# Upstream Skills Vendoring

Agent Fleet consumes the skill library from
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) as
**manually vendored content**. This repository is not a fork of upstream;
upstream is one dependency/input among several.

## Current import

| Field | Value |
| --- | --- |
| Upstream repository | `https://github.com/addyosmani/agent-skills` |
| Imported commit | `6ca0cd7db39b41b1c37e26d335c507ee92382c6d` |
| Import date | 2026-09-11 |
| Included paths | upstream `skills/` (25 skills) and `LICENSE`, copied to `vendor/agent-skills-upstream/` |

## Layout and precedence

```text
skills/                          # Agent Fleet-native skills (first-class)
vendor/agent-skills-upstream/    # pristine upstream import (read-only)
```

When a skill name exists in both locations, **the Agent Fleet-native version
in `skills/` wins**. Install/setup tooling must resolve `skills/` first and
only fall back to `vendor/agent-skills-upstream/skills/` for names not
shadowed locally.

Two kinds of native skills exist:

- **Fleet-original skills** with no upstream counterpart:
  `_internal/`, `compound-learning/`, `designing-agents/`,
  `orchestration-verification/`, `peer-coms/`.
- **Forked-and-customized skills** that shadow an upstream name. These
  carry deliberate Agent Fleet policy edits (agent operating rules, review
  gates, references to `references/prompting-patterns.md` and the
  `_internal` grilling helper):
  `browser-testing-with-devtools/`, `constraint-driven-development/`,
  `context-engineering/`, `git-workflow-and-versioning/`, `idea-refine/`,
  `incremental-implementation/`, `interview-me/`,
  `planning-and-task-breakdown/`, `spec-driven-development/`,
  `using-agent-skills/`.
- **Shadows carrying no customization.** As of the `6ca0cd7` import,
  `code-review-and-quality/`, `deprecation-and-migration/`,
  `frontend-ui-engineering/`, `performance-optimization/`, and
  `security-and-hardening/` are byte-identical to their vendored
  counterparts — the fork carried only stale upstream text, never Fleet
  policy. They stay in `skills/` for now, but each one is a candidate for
  deletion under "retire a customization" below; keeping them costs a merge
  every import for no behavioural gain.

## Modification policy

- Never edit files under `vendor/agent-skills-upstream/`. The directory must
  stay byte-identical to the recorded upstream commit so updates are a clean
  re-import.
- To customize an upstream skill, copy it into `skills/<name>/` and edit
  there; the native copy shadows the vendored one. Document why in the skill
  or in this file.
- To retire a customization, delete `skills/<name>/`; the vendored version
  becomes active again.

## Update procedure

Upstream updates are explicit maintainer actions, never automatic merges:

1. `git clone --depth 1 https://github.com/addyosmani/agent-skills.git /tmp/upstream && git -C /tmp/upstream rev-parse HEAD`
2. Replace the vendor copy wholesale:
   `rm -rf vendor/agent-skills-upstream/skills && cp -r /tmp/upstream/skills vendor/agent-skills-upstream/skills && cp /tmp/upstream/LICENSE vendor/agent-skills-upstream/LICENSE`
3. For each **shadowed** skill, diff the new upstream version against the
   native copy (`diff -r skills/<name> vendor/agent-skills-upstream/skills/<name>`)
   and manually merge upstream improvements worth keeping into the native
   copy.
4. Update the "Current import" table above (commit SHA, date).
5. Commit as a single `chore(vendor): update agent-skills-upstream to <sha>`
   commit.

Reference links inside a skill resolve from the **skill directory**, which at
install time is `.pi/skills/<name>/`. A shared checklist is therefore
`../../references/<file>.md` (landing on `.pi/references/`), while a
skill-local `references/` subdirectory — as `constraint-driven-development`
ships — is addressed as `references/<file>.md`. Do not rewrite the latter.

> Note: the shadowed skills were forked from an upstream state older than the
> current import, so upstream may contain improvements not yet merged into the
> native copies. Step 3 is where that debt gets paid down. The `6ca0cd7` import
> paid down the backlog for every shadow listed above.

## Attribution and license

Upstream `agent-skills` is © Addy Osmani and contributors, MIT-licensed. The
upstream `LICENSE` file is preserved at
`vendor/agent-skills-upstream/LICENSE` and applies to everything under that
directory, including the native skills forked from upstream. This vendoring
does not imply upstream endorsement of Agent Fleet.
