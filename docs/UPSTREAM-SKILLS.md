# Upstream Skills Vendoring

Agent Fleet consumes the skill library from
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) as
**manually vendored content**. This repository is not a fork of upstream;
upstream is one dependency/input among several.

## Current import

| Field | Value |
| --- | --- |
| Upstream repository | `https://github.com/addyosmani/agent-skills` |
| Imported commit | `c1974de476a39cb002a3b8e51e6a7e8e57b808c6` |
| Import date | 2026-07-16 |
| Included paths | upstream `skills/` (24 skills) and `LICENSE`, copied to `vendor/agent-skills-upstream/` |

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
  `guided-workspace-setup/`, `orchestration-verification/`, `peer-coms/`.
- **Forked-and-customized skills** that shadow an upstream name. These
  carry deliberate Agent Fleet policy edits (agent operating rules, review
  gates, references to `references/prompting-patterns.md` and the
  `_internal` grilling helper):
  `browser-testing-with-devtools/`, `code-review-and-quality/`,
  `context-engineering/`, `deprecation-and-migration/`,
  `frontend-ui-engineering/`, `git-workflow-and-versioning/`,
  `idea-refine/`, `incremental-implementation/`, `interview-me/`,
  `performance-optimization/`, `planning-and-task-breakdown/`,
  `security-and-hardening/`, `spec-driven-development/`,
  `using-agent-skills/`.

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

> Note: the shadowed skills were forked from an upstream state older than the
> current import, so upstream may contain improvements not yet merged into the
> native copies. Step 3 is where that debt gets paid down.

## Attribution and license

Upstream `agent-skills` is © Addy Osmani and contributors, MIT-licensed. The
upstream `LICENSE` file is preserved at
`vendor/agent-skills-upstream/LICENSE` and applies to everything under that
directory, including the native skills forked from upstream. This vendoring
does not imply upstream endorsement of Agent Fleet.
