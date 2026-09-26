# Apply contract: candidate diff → reviewed apply → verified provenance

Deterministic rules for writing target `.ai/` content, sidecar entries,
pointer edits, and adapters. This reference holds no merge algorithm for
overrides and no transaction subsystem: content and sidecar go through
`applyAcceptedProjectFiles` in `bin/lib/project-provenance.js` (backed by
`bin/lib/transaction.js`), pointer regions through `extractRegion` /
`replaceRegion` in `bin/lib/merge-forms.js`, and settings through
`agent-fleet configure`. The model produces candidate bytes; only reviewed,
accepted bytes are written.

## Candidate diff

Show a concrete diff before every write: file path, classification, the
recorded decision it implements, and the full new bytes (or region-scoped
hunk for pointer edits). Unrelated files and unrelated hunks are explicitly
out of scope in the diff header. A stale preview — bytes changed after the
diff was shown — is re-shown, never applied blindly.

## Classification → action

Computed by `classifyProjectFile` (current bytes vs `appliedHash`, source
identity/version/hash vs the sidecar record):

| Status | Action |
|---|---|
| `unchanged`, no requested change | Byte-identical no-op. No generator call, no timestamp or metadata touch. |
| `unknown` (missing / corrupt / unrecorded / unknown template / deleted) | Human-owned or broken state. Propose adoption or repair; apply only with explicit `adopt` acceptance. Never overwrite or auto-restore. |
| `local-edit` | Preserve the file. On a requested update touching it, reconcile: keep the accepted local lines, add the new decision's content, and say what was kept. |
| `source-update` | Template changed, local bytes clean. Candidate shows the adapted update (re-adapted to the target, not pasted); review before apply. |
| `conflict` (source and local both changed) | Explicit reconciliation preserving accepted local choices. No automatic three-way merge; a missing base snapshot is reported, never invented. |

An apply that meets anything but clean `unchanged` / `source-update`
without `adopt` / `reconciled` fails loudly instead of overwriting.

## Write and record

- `applyAcceptedProjectFiles` writes only changes carrying explicit
  `accepted: true`, then records the sidecar entry (origin, evidence,
  accepted decision, inputs, `appliedHash` of the exact bytes written)
  **only for files successfully written and re-read**. Preserve / skip never
  changes `appliedHash`.
- Partial apply and interruption leave a visible mismatch, never a success
  report: the transaction rolls project files and sidecar back together, and
  the error states exactly what was written and what remains.
- Repeating a fulfilled request writes nothing new: same bytes re-classify as
  `unchanged`, no duplicate files, adapters, or index entries.

## Pointer edits and adapters

- Small pointer edits in human-owned files (`AGENTS.md`, docs indexes) are
  key- or region-scoped (`extractRegion` / `replaceRegion`): the managed
  region is replaced, everything outside the sentinels is preserved
  byte-for-byte. They never convert the host file into a generated file and
  never gain provenance entries.
- Target-local slash adapters resolve their canonical `.ai/commands` source
  and pass invocation inputs; they copy no policy. One adapter per selected
  command, created once, never duplicated on repeat runs. Adapters and
  human-owned files are not installer-owned items.

## CLI integration

Settings are not written here. The skill shows the `agent-fleet configure`
preview (`--dry-run`), the user reviews `before` / `after` /
`expectedHash`, and the CLI applies (`--expect-hash … --yes`). Omitted keys
stay byte-identical. See `setup-flow.md` §4 for the exact commands.

## Semantic bar

Every adapted file is checked for meaning, not just paths: no imported
reference-repository defaults without target evidence, no invented
paths/checks/commands, no dropped applicable constraint, and consistency
across the adapted rules, commands, and agent prompts. A path-substitution-only
result fails review.
