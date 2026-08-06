# Major-release migration matrix

This release retires the conversational setup layer in favour of a deterministic
three-command lifecycle. It is a migration guide, not an installer transcript.

| Situation | Command | Result / gate |
| --- | --- | --- |
| Fresh Default automation | `npx @chankov/agent-fleet@<exact-version> setup --preset default --features none --yes` | Reproducible stable Fleet Core, no voice configuration or `.claude/`. |
| Fresh Full automation | `npx @chankov/agent-fleet@<exact-version> setup --preset full --features none --yes` | All stable, platform-applicable catalogue roots; experimental Codex Remote remains excluded. |
| Interactive latest | `just fleet setup` | Run from the target repository in a real TTY. It resolves `npx @chankov/agent-fleet@latest setup`, selects Default/Full and optional features, prints the exact reconciliation plan, then confirms once before applying. Registry access is required unless `@latest` is cached. |
| Stable features | `... setup --preset default --features voice,browser --yes` | Features are named additions. `hermes`, `telegram` (requires `hermes`), and `claude-bridge` are stable; `codex-remote` is an explicit experimental opt-in. |
| Existing desired state | `... setup --preset full --features none --yes` | Flags are ephemeral; existing `.ai/agent-fleet.json` is unchanged. Add `--save-desired` to persist overrides. |
| First legacy migration preview | `... setup --migrate --dry-run` | Lists exact state-owned removals; no consent or writes. |
| First legacy migration mutation | `... setup --migrate --preset default --features none --yes` | Automation requires all three gates: `--migrate`, explicit preset/features, and `--yes`; only unchanged owned extras are removed. |
| Legacy record without state | `... setup --migrate --dry-run` | Preview first; do not assume unrecorded files are owned or removable. |
| Conflict | `... setup --on-conflict ours` or `... setup --on-conflict theirs` | Without a policy setup exits 3 before writes. `ours` keeps the local copy; `theirs` takes the package version. |
| Read-only diagnosis | `... doctor` | Never prompts or writes; actionable findings exit 2, advisory-only output exits 0. |
| Repair | `... doctor --fix` | Recovers interrupted transactions and pending runtime repairs. If a transaction backup was reaped, doctor reports the unrecoverable journal; `--fix` safely discards that installer-owned journal because restoration is impossible. |
| Normal removal | `... uninstall --all --yes` | Removes only recorded, unchanged artifacts; desired/override/STT configuration and environment files remain. |
| Config purge | `... uninstall --all --purge-config --yes` | The separate destructive gate removes desired/override/STT config; environment files remain. |
| Self-hosted removal | `just fleet uninstall --yes` | Removes ordinary content, then launcher/managed region, then state; its in-memory report still completes. |
| Self-hosted reinstall | `npx @chankov/agent-fleet@latest setup --preset default --features none --yes` | Restores `just fleet`; then run `just fleet doctor`. |

`just fleet deps` installs nested `.pi/extensions` and `.pi/harnesses` npm dependencies;
`just fleet install` was removed. `pi update --extensions` updates pi extensions only,
not the npm installer: use `just fleet setup` to resolve `@latest` and reconcile.
Published-package commands above use `npx`; source-checkout development uses
`node bin/cli.js setup` with equivalent flags.

## Compatibility aliases

New documentation and automation must use `setup`, `doctor`, and `uninstall`.
`init` and `update` dispatch to `setup`. `install` and `upgrade` remain deprecated
legacy commands with their historical selection/three-way-merge semantics (and
emit a warning); they are not replacements for deterministic automation and do
not restore retired prompt or skill surfaces.

## Ownership and configuration rules

The state file is the only deletion authority. Unknown extensions, hooks,
settings, recipes, and files are not adopted. Locally modified owned files are
kept. Desired state belongs to `.ai/agent-fleet.json`; project overrides and
STT configuration are human configuration and remain through normal uninstall.
Secrets are referenced by environment-variable name only and are never written
to state, journals, desired state, or `.ai/stt.json`. The installer-owned
`.ai/agent-fleet-transaction.json` is a crash-recovery journal; it is removed
on success or recovery, and is never a user configuration file.

## Retired surfaces

The retired installer implementation and its two setup/doctor prompts are
intentionally absent. All other `af-*` lifecycle and
operational prompts remain public. Historical changelog and planning text may
mention the retired surfaces as history only.
