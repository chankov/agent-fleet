---
"@chankov/agent-fleet": patch
---

Correct and expand the install/update documentation for the deterministic
lifecycle.

Three corrections, each of which was actively misleading:

- **First install no longer tells you to run `just fleet setup`.** The managed
  justfile region is written *by* setup, so in a repository without Agent Fleet
  that command fails with `error: no justfile found`. README, `docs/getting-started.md`,
  `docs/npm-install.md`, `docs/MIGRATION-agent-fleet.md`, and the `just fleet help`
  banner now lead the first install with `npx @chankov/agent-fleet@latest setup`
  and present `just fleet setup` as the wrapper available once the workspace has
  a justfile.
- **`setup` does not preserve local edits.** README, `docs/agent-fleet-setup.md`,
  and the migration guide claimed reconciliation "never eats a local edit". Under
  `setup` a locally modified owned file is refreshed and the edit is overwritten
  (`plan.js` plans it as `refresh … overwrites: true`); only the deprecated
  `upgrade` verb preserves it. The docs now state this plainly, show the plan line
  that predicts it, and point at `.ai/agent-fleet-overrides.md` as the supported
  customization route.
- **The runtime-dependency step was easy to miss.** The two `npm` companions are
  `consent: exec` and plan as `skip`, so a workspace is not launchable until
  `just fleet deps` (or `setup --allow-exec`) runs. It is now part of the install
  sequence rather than an aside.

New material: a step-by-step **"Updating an existing install"** section covering
the update banner, `check-update`, the `--dry-run` preview and how to read each
action line, applying, and resolving an exit-`3` conflict with `--on-conflict
theirs|ours`; and a per-state table of what reconcile does to every file,
including the degraded two-way comparison when a `.versions/` baseline is absent.

`docs/MIGRATION-agent-fleet.md` is rewritten from a lifecycle-only matrix into a
guide to all four breaking changes in this release — the deterministic lifecycle,
Claude Code losing install-target status, the OpenCode removal, and the unified
`just fleet` runtime — each with the commands to migrate an affected workspace.
