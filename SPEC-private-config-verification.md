# Spec: Private Codex notification configuration verification

Status: implemented in the working tree; fixture verification is recorded in the implementation handoff. Independent review of the ENTIRE feature remains pending; not accepted or activated, and no loaded-runtime claim is made.

## Objective

Support independent, runtime-evidenced current-state verification of an explicitly selected private Codex notification configuration outside Git. A successful configuration-only preparation must not require a fake repository edit, copying private data into Git, or claiming historical authorship.

The existing `changes` and `operator-current-state` modes remain unchanged. Successful specialist prose, a shell transcript, or exit code alone must not close an obligation.

## Approved boundaries

The human authorized this separate verification-support fix with tests and independent review. This does not authorize reload, notification enable, another protected live test, automatic expiry renewal, new Fleet rights, policy changes, or exemptions. The earlier notification candidate expires at 2026-11-10T00:18:24.872Z; this implementation must not change that deadline.

## Approved contract

- Add a distinct opt-in `private-config-current-state` review mode, not a relaxation of either existing mode.
- Accept only an explicit bounded set of current, regular, single-link, owner-private JSON files in one canonical agent-fleet Codex-notification state namespace. At least one selected file must be a valid notification configuration. Do not accept arbitrary external paths, environment/credential files, globs, traversal, symlinks, or an override of the trusted root through tool parameters.
- Require the existing native, independent, read-only reviewer constraints and explicitly declared test/code-grep/compiler commands. Do not silently substitute another backend.
- Bind all declared private inputs, verifier/helper source files, task, scope, declarations, session/capture epoch, and repository revision into runtime-owned evidence. Re-read relevant fingerprints before accepting/reusing evidence. Reject mutation, missing/tainted capture, mismatched task/revision/declarations, overlap, failed/unknown checks, unsupported assertions, or missing independent review.
- Private bytes remain private: do not attach configuration bodies as model artifacts, copy them to repository/session reports, emit them in notifications, or place them in logs. Evidence may contain bounded metadata and digests only. Existing artifact and source-access guards stay in force.
- A reviewer must still assess semantic adequacy of operator-authored verifiers. Runtime evidence proves execution and state binding, not the adequacy of the test.
- Record a distinct private-current-state origin. Do not invent a Git change or put external paths into the Git changed-files ledger. A PURE configuration-only task may satisfy ITS OWN private acceptance/review obligations and assertion-prove process gate through fresh native evidence and independent review. Ordinary Git stage refs and review-reuse records remain separate. Registered source work, Git stage evidence/origin or active source review additions exclude private closure; no unrelated source obligation is covered. Revalidate private/helper fingerprints, task/session, generation/epoch/capture, declarations, revision, evidence bytes and concurrency at actual proof/gate use, not only on review return.
- No historical attribution, activation, approval, permission decision, journal replay, or extension of existing event/request deadlines is implied.

Implemented parameters are `private_config_files` (1–4) and `verifier_sources` (1–32). Helpers are canonical owned non-group/world-writable source files (js/mjs/cjs/ts/mts/cts/sh/py), at most 1 MiB each. Private configuration files are at most 64 KiB and must match the namespace thread UUID; canonical owned namespace ancestors cannot be group/world-writable. The private proof uses bounded metadata/digests and readback-bound native receipt/reviewer/proof evidence. These narrow implementation choices preserve the approved separate-scope contract.

Final helper names are routine implementation details, following existing dispatcher conventions. No generic outside-Git file-reading capability is in scope.

## Implementation surface

Expected owning layers: agent-hub review-mode types/schema, a focused private-config capture/proof module, native receipt declaration/observation binding, dispatcher acceptance/review integration, regression tests, and verification documentation. Keep feature-specific file validation out of the general Git scope engine.

## Verification commands

The repository uses Node's built-in test runner and TypeScript stripping. Focused new tests will follow existing agent-hub conventions:

```sh
node --experimental-strip-types --test .pi/harnesses/agent-hub/private-config-current-state.test.ts
node --experimental-strip-types --test .pi/harnesses/agent-hub/private-config-dispatch.test.ts
npm run typecheck:hub
npm run typecheck:workflows
node --test .pi/agent-fleet/scripts/docs-links.test.mjs
npm run test:fleet-native
```

Whole-Hub regression uses the actual Node runner, not a `test:hub` npm alias.
Run only with the required operator approval; the final whole-Hub run is
parent-owned and must use the frozen reviewed revision. In Bash:

```bash
mapfile -t hub_tests < <(
  find .pi/harnesses/agent-hub -type f \\
    \( -name '*.test.ts' -o -name '*.test.js' \) | sort
)
node --import ./bin/test/helpers/system1-no-network.js \\
  --experimental-strip-types --test --test-timeout=120000 \\
  --test-concurrency=2 "${hub_tests[@]}"
```

The no-network preload applies to existing Hub fixtures as well as extension and
package probes. Focused passing subsets are not proof of the whole-Hub assertion.
The docs runner is the direct Node command above; no `test:agent-fleet:docs`
script exists. `package.json` is not modified for this feature.

## Acceptance criteria

1. An explicitly scoped valid private fixture can obtain a current-state proof only through independent review plus actual capture-anchored native checks, despite no Git source delta.
2. Old modes and ordinary changed-work acceptance retain their existing requirements.
3. Unsafe files/paths and overly broad scopes fail closed; no private body is exported.
4. Mutation, stale/replayed/foreign evidence, wrong backend/persona, concurrency, missing/tainted capture and failing checks cannot close verification/review.
5. Verifier/helper mutations are detected even when the helper is a Git-ignored session artifact.
6. No new mode operation starts/reloads a daemon, enables notifications, modifies grants/exemptions/rules, retries delivery, or performs the protected action.
7. The native review has no authority to cover unrelated repository changes or to convert unsupported manual/UI assertions into proven assertions.

## Delivery discipline

Write a failing regression before behavior changes. Deliver one narrow end-to-end capability, without staging/committing. Run focused tests, both typechecks, applicable full regressions and independent review. Update the architecture and operator verification docs. Do not claim a new live permission-delivery test or loaded-runtime support until separately authorized and actually observed.
