---
"@chankov/agent-fleet": minor
---

`doctor` repairs through the install engine, and `uninstall` lands (Phase 6 of `plans/deterministic-installer.md`).

- **`agent-fleet doctor [--fix]`** now has two halves in one report. Recorded items that are missing, dangling, or linked outside the source root are rebuilt through the *same* `apply()` path `install` writes with — a repaired file is byte-identical to a freshly installed one. The old scan stays for what the install record cannot own: broken links in a pre-engine workspace, and stale persona names in `.pi/agents/*.yaml`. Overrides problems and malformed `peers.yaml` entries remain advisory. Exit `2` when anything repairable is left, `--json` for the machine report, `--dry-run` to look without being asked anything.
- **`agent-fleet uninstall --items <id,…> | --all`** removes what the state file records, and only that. A recorded file whose bytes no longer match what we wrote is kept and listed as skipped. A companion travels with its parent unless another installed item still needs it, and an item another installed item pins is refused by name — so removing one pi extension cannot delete the `package.json` five others run from, and removing `damage-control-continue` while `agent-hub` is installed is refused rather than silently leaving the hub without its safety harness. Removing the last pi harness strips the `agent-fleet:harnesses` region from the `justfile` and leaves the rest of the file alone.
- **Hermes and Codex are real profiles.** `install --profile hermes-plugins --dry-run` (and `codex-bridge`) prints the exact command list for each artifact and touches nothing. Their targets are a Hermes profile and a user systemd unit — outside the workspace, the one place the engine writes — so they stay `operator`-consent by design. Every operator item now declares its steps in the manifest, and the manifest build fails if one does not.

Two fixes to the write path, both cases where a filesystem call silently did nothing:

- A **dangling symlink was never replaced** — `rmSync(path, { force: true })` stats through the link, saw ENOENT, and returned as if the path were already gone, so the replacing `symlinkSync` failed `EEXIST`. Repairing a broken link is exactly the case that hit this.
- **Emptied directories were left behind** on removal — the non-recursive `rmSync` throws `EISDIR` on any directory, so the prune walk aborted on its first step.
