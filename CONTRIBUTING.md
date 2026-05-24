# Contributing to Agent Skills

Thanks for your interest in contributing! This project is a collection of production-grade engineering skills for AI coding agents.

## Adding a New Skill

1. Create a directory under `skills/` with a kebab-case name
2. Add a `SKILL.md` following the format in [docs/skill-anatomy.md](docs/skill-anatomy.md)
3. Include YAML frontmatter with `name` and `description` fields
4. Ensure the `description` starts with "Use when" and describes triggering conditions

### Skill Quality Bar

Skills should be:

- **Specific** — Actionable steps, not vague advice
- **Verifiable** — Clear exit criteria with evidence requirements
- **Battle-tested** — Based on real engineering workflows, not theoretical ideals
- **Minimal** — Only the content needed to guide the agent correctly

### Structure

Every skill should include these sections:

- **Overview** — What this skill does and why it matters
- **When to Use** — Triggering conditions
- **Process** — Step-by-step workflow
- **Common Rationalizations** — Excuses agents use to skip steps, with rebuttals
- **Red Flags** — Warning signs that the skill is being applied incorrectly
- **Verification** — How to confirm the skill was applied correctly

### What Not to Do

- Don't duplicate content between skills — reference other skills instead
- Don't add skills that are vague advice instead of actionable processes
- Don't create supporting files unless content exceeds 100 lines
- Don't put reference material inside skill directories — use `references/` instead

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

### Release flow

1. PRs merge to `main` with their changeset files.
2. The release GitHub Action opens (or updates) a "Version Packages" PR that
   aggregates pending changesets into one version bump + `CHANGELOG.md` update.
3. Merging that PR triggers `changeset publish` — the package goes to npm and a
   matching git tag (`v<x.y.z>`) is pushed.
4. The same workflow snapshots the active artifacts into `.versions/<x.y.z>/`
   so that future installs can run a three-way diff against this exact release.

### Backporting a version-aware change

If your change touches the install record schema or any installable artifact
in a way the version-aware update flow needs to detect, document it explicitly
in the changeset body — `guided-workspace-setup` reads the CHANGELOG between
the recorded version and the current version when deciding which Status to
show in the install menu.

## Reporting Issues

Open an issue if you find:

- A skill that gives incorrect or outdated guidance
- Missing coverage for a common engineering workflow
- Inconsistencies between skills

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
