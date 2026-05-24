# Changesets

This directory holds [changeset](https://github.com/changesets/changesets) files —
one per user-visible change. They drive the version bump and `CHANGELOG.md`.

## Workflow

1. Make your change.
2. Run `npx changeset` and follow the prompts. Pick the bump level:
   - **patch** — wording fix, clarified red flag, doctor scan improvement,
     CLI bug fix, new example.
   - **minor** — new skill, new persona, new command, new option in an existing
     skill, new optional override key.
   - **major** — skill removed, renamed, or its documented workflow changes in
     a way users have built habits around; persona retired; command removed;
     install-record schema breakage.
3. Commit the generated `.changeset/<random-name>.md` file with your change.

On merge to `main`, the changesets GitHub Action opens (or updates) a
"Version Packages" PR that rolls every pending changeset into a single version
bump + `CHANGELOG.md` update. Merging that PR triggers the npm publish.

## Bump rules cheatsheet

| Change | Bump |
|---|---|
| Skill removed, renamed, or its documented workflow changes | major |
| Persona retired | major |
| Command removed | major |
| Install-record schema breakage | major |
| New skill / persona / command | minor |
| New option in an existing skill | minor |
| New optional override key | minor |
| Wording fix, clarified red flag | patch |
| Doctor scan improvement | patch |
| CLI bug fix | patch |
| New example | patch |
