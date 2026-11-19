# Contributing to Agent Fleet

Thanks for your interest in contributing! Agent Fleet is a Pi-centered multi-agent orchestration system plus a library of production-grade engineering skills for AI coding agents.

> **Two skill roots.** Fleet-native and customized skills live in `skills/`; `vendor/agent-skills-upstream/` is a pristine import from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) and must **never be edited directly** — to improve a vendored skill, either contribute upstream or copy it into `skills/<name>/` as a customized shadow (see [docs/UPSTREAM-SKILLS.md](docs/UPSTREAM-SKILLS.md)).

## Adding a New Skill

### Before proposing a new skill

This pack already covers most of the development lifecycle, and many proposals overlap with an existing skill or another open PR. Before opening one, do these checks so reviewers aren't triaging duplicates:

1. **Search the catalog.** Browse [the skill list in the README](README.md) and skim `skills/` for an existing skill that covers your idea, whole or in part.
2. **Check open PRs.** Run `gh pr list --state open` (or browse the PRs tab) and look for proposals on the same topic. Clusters of near-duplicate skills already exist; don't add to them.
3. **Read the anatomy.** Confirm your idea fits the format in [docs/skill-anatomy.md](docs/skill-anatomy.md), an actionable workflow with verification, not vague advice.
4. **Justify the gap in your PR description.** State explicitly why this isn't covered by an existing skill or open PR. If it overlaps, propose extending the existing skill instead of adding a new one.

If your idea is a refinement of an existing skill, prefer a focused edit to that skill over a new directory.

### Creating the skill

Follow the template and verification guidance in the
[skill authoring guide](docs/skill-anatomy.md).

## Modifying Existing Skills

- Keep changes focused and minimal
- Preserve the existing structure and tone
- Test that YAML frontmatter remains valid after edits

## Versioning & releases

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and uses [changesets](https://github.com/changesets/changesets) to manage the
changelog and version bumps.

### Adding a changeset

Every PR with a user-visible change must include a changeset. After making
your change:

```bash
npx changeset
```

The interactive prompt asks for a bump level and a one-line summary. It writes
a `.changeset/<random-name>.md` file — commit that alongside your change.

### Bump rules

| Change | Bump |
|---|---|
| Skill removed, renamed, or its documented workflow changes in a way users have built habits around | **major** |
| Persona retired; command removed; install-record schema breakage | **major** |
| New skill, new persona, new command, new option in an existing skill, new optional override key | **minor** |
| Wording fix, clarified red flag, doctor scan improvement, CLI bug fix, new example | **patch** |

> **Note:** the release pipeline runs `bin/force-patch-changesets.js` ahead of
> `changeset version`, which rewrites every pending `minor`/`major` changeset
> down to `patch` — so the table above describes intent, not the version number
> you will actually get. To keep an authored bump, add the YAML comment
> `# release: keep-bump` to the changeset's frontmatter. Reserve it for releases
> where the version number is itself the signal (a removed runtime, a retired
> command, an install-record break).

### Pre-merge release checks

Run these checks before committing, including when new files are still untracked:

```bash
npm test
npm run test:portability
npm run check:manifest
npm run pack:dry
git diff --check
```

The source-path guard includes non-ignored untracked files and parses import
syntax rather than matching import-looking fixture strings. Temporary-directory
checks use `os.tmpdir()` and a second, non-default temp root; real-compiler
regressions also exercise symlinked worktrees (including macOS path aliases).

The Release workflow runs the same Linux/macOS validation on pull requests and
main. PR jobs have read-only permissions and cannot publish. Publishing runs only
on main after both validation jobs pass. Repository administrators should make
`Installer (ubuntu-latest)` and `Installer (macos-latest)` required status checks
for main and require PRs; workflow files alone do not prevent direct pushes or
merging failed checks. This change does not configure repository protection.

There is no release PR. Do not grant publishing privileges to PR validation.

### Release flow

1. Changes reach `main` with their changeset files.
2. After both validation jobs pass, the Release job versions only if pending
   changesets exist: `npm run version:changeset` aggregates them into a version
   bump + `CHANGELOG.md` update, synchronizes adjacent harness version stamps,
   refreshes `package-lock.json`, and snapshots active artifacts into
   `.versions/<x.y.z>/` for future three-way diffs against this release.
3. That result is committed as `chore: release v<x.y.z> [skip ci]` and pushed
   straight to `main` (`[skip ci]` keeps it from starting another run).
4. The same run then calls `changeset publish` — the package goes to npm, the
   `v<x.y.z>` tag is pushed and a GitHub Release is created from the changelog
   section. A push without pending changesets publishes nothing new.

### Backporting a version-aware change

If your change touches the install record schema or any installable artifact
in a way the version-aware update flow needs to detect, document it explicitly
in the changeset body — the deterministic CLI uses the recorded version and
snapshot tree to plan the next reconciliation.

## Reporting Issues

Open an issue if you find:

- A skill that gives incorrect or outdated guidance
- Missing coverage for a common engineering workflow
- Inconsistencies between skills

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
