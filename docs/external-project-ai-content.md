# External project AI content

Fleet lifecycle state stays in the checkout's real local `.ai/` directory. Project rules and documentation can be read from separately configured directories; these read grants never authorize writes, command execution, native resource registration, or remote capture.

## Read grants

Configure local `.ai/agent-fleet-overrides.md` through the existing CLI:

```bash
agent-fleet configure --rules ../rin-docs/.ai/rules --docs ../rin-docs --dry-run
# Review the preview, then use its expectedHash with --expect-hash and --yes.
```

A directory-form docs grant authorizes its permitted descendants. An exact-file grant such as `../rin-docs/README.md` authorizes only that file, not its neighbors or parent inventory. Missing roots have diagnostics; ungranted siblings, secret/generated paths and descendant symlink escapes remain denied. An explicitly configured symlink root is admitted at its canonical destination and rechecked on access.

Paths resolve from the checkout, not from a nested child cwd. Each worktree resolves its own sibling paths; a missing sibling does not trigger parent-directory discovery. Child prompts use canonical external references. Filesystem handles retain source/root identity and hashes; changed grants or bytes invalidate readback. Snapshot writes remain managed and checkout-local.

## System 1 policy and evidence

Existing `.ai/rules/...` bindings resolve through configured rules roots without changing the binding strings. Multiple candidates, including an old local copy plus an external copy, are ambiguous. Relocation never repins changed content: hash and heading occurrence still have to match.

`proactiveReview.include` is separate capture consent. External entries require an admitted content root; a read grant alone does not enable provider capture. Capture retains its redaction, byte/file/time limits and consumer mode. Independent external Git worktrees provide their own HEAD evidence, including earlier dirty modifications, deletions and untracked additions. Without Git, bounded turn snapshots can show only changes since capture; `external_history_unavailable` reports the earlier-history gap. Missing evidence and changed HEAD remain gaps, never a clean review.

File-discovery has narrower workspace-only export/include permissions. External policy read grants do not enable remote file-discovery ranking.

## Native commands and skills

Pi does not register arbitrary `.ai/commands` or `.ai/codex-skills` directories merely because docs grants cover them. Use reviewed thin local `.pi/prompts` adapters that reference the canonical external command path, or explicitly register a skill path in Pi settings. Project resource settings resolve relative to `.pi`, not the checkout: an external skill can be listed as `../../rin-docs/.ai/codex-skills/example` or by absolute path. Review resource content and project trust separately. Discovery and prompt expansion do not execute skill scripts.

## Reviewed generation destination

The project-AI API accepts a separate explicit destination, not an overrides write grant:

```js
applyAcceptedProjectFiles({
  workspace: checkout,
  contentDestination: {
    root: "../rin-docs",
    acceptedDecision: "Maintainer approved writing adapted content here",
    evidence: ["review:destination-approval"],
  },
  changes: reviewedChanges,
});
```

Logical change paths remain `.ai/rules/...`, `.ai/commands/...`, or `.ai/agent-prompts/...`. The destination must already be a real separate directory, not a checkout ancestor, descendant or symlink. Existing adoption, reconciliation, per-content hashes and no-op semantics apply. Supply the reviewed destination again for later classification/apply; read settings never infer it.

The provenance sidecar, locks, transaction journal and recovery backups stay local. External content is never installer-owned; setup, upgrade, doctor and uninstall do not adopt or remove it. Recovery validates the recorded destination and backups before restoring touched files. Private recovery copies are temporary lifecycle artifacts, not installed content. Missing or unsafe destinations fail closed; repair them before recovery. Installer safety checks are not disabled.
