# TODO — Issue #135

## Setup

- [x] Read the issue and current contributor docs
- [x] Confirm the repo no longer depends on empty `scripts/` directories being present

## Docs update loop

- [x] Clarify in `docs/skill-anatomy.md` that `scripts/` is optional and should not be created empty
- [x] Reinforce the same rule in `CONTRIBUTING.md`
- [x] Update the `AGENTS.md` template so script-backed usage examples are clearly optional

## Verification

- [x] `rg` confirms the docs explicitly describe optional `scripts/` usage
- [x] `git diff --check` passes
- [x] Self-review confirms the diff stays docs-only and scoped to the scripts-directory rule

## Wrap-up

- [ ] Commit, push, and open PR
