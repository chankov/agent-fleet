---
"@chankov/agent-fleet": minor
---

Make `install` and `upgrade` real: the apply engine (Phase 4 of `plans/deterministic-installer.md`, completing Phase 5).

A brand-new repository can now be set up with one command and no coding agent in the loop:

```
npx @chankov/agent-fleet@latest install --agent pi --profile recommended --yes
```

- **`agent-fleet install`** applies a plan: copies, symlinks (`--method symlink`), generates personas through the tested transformer, rewrites the `justfile` managed region, and merges only agent-fleet's own keys into `.claude/settings.json`. Run without a selection in a terminal it asks which profile; piped, it requires the flags rather than guessing. `--yes` skips the single confirmation; `--allow-exec` admits the items that run a command, which are ordered after all file work so they see the finished tree.
- **`agent-fleet upgrade`** applies the three-way merge: clean upgrades land, local edits are preserved, and a file changed both locally and upstream is written beside yours as `<file>.new` while your copy is left untouched (exit `3`).
- **State and record.** Every pass writes `.ai/agent-fleet-state.json` — per-file hashes, ownership, method, version — and renders `.ai/agent-fleet-setup.md` from it, so the human record can no longer disagree with the machine one. The state file is written even when a pass fails partway, so a workspace never holds files it has no record of.
- **Safety is enforced, not documented.** Nothing is written outside the workspace, nothing is deleted that the state file does not record as ours, and nothing you have edited is deleted at all — a removal reports what it kept and why.

`verify` now compares the two shared-file forms for real (a managed region by its sentinel-bounded block, a JSON merge by its declared key paths) instead of reporting them as unchecked, so your own `justfile` recipes and settings keys never read as drift. Installing twice is a no-op, asserted in tests.

Unchanged: `init`, `doctor`, `update`, `cleanup-installer`, and the guided setup skill.
