---
"@chankov/agent-fleet": major
# release: keep-bump
---

Replace guided LLM setup with three deterministic lifecycle commands:
`setup`, `doctor`, and `uninstall`. Desired-state config, strict state-owned
removal with human-config preservation, legacy alias migration, and
preservation of overrides/STT config ship together in one major release.

**Breaking for anyone who relied on the old guided flow.**
`init` / `install` / `upgrade` / `update` remain compatibility aliases that
route toward `setup` (or the legacy plan verbs) with deprecation warnings;
`cleanup-installer` and the guided-workspace-setup skill/prompts are gone.
Setup no longer accepts raw `--items` / `--profile` selectors — use
`--preset <default|full>` and `--features <name[,name]|none>` instead.

What changed:

- **Desired-state config.** Selection lives in human-owned
  `.ai/agent-fleet.json` (preset + features). CLI flags are ephemeral unless
  `--save-desired` persists them. First-time migration from a state-only
  workspace requires `--migrate` with an explicit preset/features and `--yes`.
- **Strict state-owned removal.** `uninstall` only removes paths recorded in
  `.ai/agent-fleet-state.json` whose bytes still match what we wrote. Human
  and foreign files are never touched. `--purge-config` is a separate explicit
  gate for `.ai/agent-fleet.json`, `.ai/agent-fleet-overrides.md`, and
  `.ai/stt.json`.
- **Alias migration.** Deprecated `init`/`update` hand off to `setup`;
  `install`/`upgrade` keep plan-verb compatibility where needed and warn.
- **Overrides and STT preserved.** Default uninstall and reconcile leave
  project overrides and voice STT config alone unless `--purge-config` is
  consented. Crash recovery uses `.ai/agent-fleet-transaction.json`.
- **Conflict policy on setup.** Three-way conflicts abort before writes
  (exit `3`) unless resolved with `--on-conflict theirs|ours`. Legacy
  `upgrade` still uses `--accept-theirs` / `--accept-ours`.
- **Just lifecycle and repaired setup UX.** `just fleet install` was removed;
  use `just fleet deps` for nested runtime dependencies. `just fleet setup`
  resolves the package through npm `@latest`. JSON setup now applies when
  consented with `--yes`, failed file transactions roll back rather than report
  success, and the interactive TUI can authorize a first legacy migration only
  after its exact migration preview and final confirmation.

See `docs/agent-fleet-setup.md`, `docs/MIGRATION-agent-fleet.md`, and
`docs/npm-install.md` for the operator-facing lifecycle.
