# System1 context continuity (D7)

## Runtime behavior

D7 adds a runtime-owned recovery coordinator and shared native child adapter.
The real `Pi 1.3.0 --mode json -p --no-extensions` contract is verified offline
(previously verified Pi 1.1.0 and 1.2.0 remain admitted)
with fake inference, actual Pi compaction, persisted tool results, and subsequent
continuation. Runtime detection resolves npm-bin symlink launchers before reading
the owning Pi package version. Other runtime versions remain on their native baseline; a method
called `compact` alone is not a capability proof.

Automatic compaction has a 50% minimum, 60% early opportunity, deterministic 70%
target and 80% ceiling (operator-approved 2026-10-15). Explicit manual requests
remain independent of the automatic minimum. At a safe boundary,
the coordinator awaits compaction and successful runtime restoration before
sending at most one custom continuation. It does not send synthetic user input,
reset task/turn budgets, grant permissions, restart a child or replay tool effects.
A real queued user input (including images) takes priority. Restore failure and
existing model-work gates suppress synthetic continuation.

`request_compaction` joins the same coordinator when running under supported Hub.
Its public tool parameters remain compatible. Pressure-only capability refreshes
preserve the current explicit compaction request even at low context usage; a
subsequent unrelated user request clears it. It is not a permanent task pack.
When `set_task_tier(new_task:true)` is authorized, old packs and confirmations
are cleared first, then capabilities are re-derived from a snapshot of the current
accepted user input. The model's reason is not used as user intent, raw input is
not persisted in capability state, and session startup/resume does not rebind it.
Before a non-pressure explicit request, the supported Hub uses Pi's actual
compaction preparation with the effective retention settings. If there is no
compactable history (including a session smaller than the default 20,000 recent
tokens), it records `skipped`, not compact/restore success or pressure failure.
A requested continuation still runs once under the same identity/gates, with real
queued user input taking priority. Mandatory pressure recovery is never skipped
by this rule. Explicit and automatic requests have distinct UI messages.
Without a managed Hub controller, the standalone extension retains its existing
queue behavior.

Every common native physical spawn explicitly loads `context-continuity-child.ts`.
The adapter measures the child's own model window and runs pressure recovery in
the same process/attempt. Parent-owned authenticated Unix-socket messages are limited
to `context_status` and `context_assessment`; there is no eval, command or permission
API. Assignments are revoked on cancellation/settlement. Child environment strips
inherited D7 assignments and System1 keys before receiving its fresh assignment.

External peers do not receive remote compaction control. Claude bridge usage is
`unknown`, not a fabricated zero. Registry records distinguish measured 0% from
missing/legacy measurement. Context budget diagnostics include child owner,
physical attempt, measurement, episode and last phase without exposing channel tokens.

## Enable

Deterministic pressure recovery does **not** require System1 selection, keys,
fileDiscovery or any semantic consumer. Launch the normal Agent Fleet Hub on the
verified Pi 1.3.0 runtime; no extra user `continue` is required for an interrupted,
still-authorized step after successful recovery.

Optional early semantic advice uses the existing **single** `.ai/system1.json`
v2 document. The complete [system1.example.json](system1.example.json) covers D7
and every supported consumer with remote inference/consent disabled. Follow the
[per-consumer setup and usage guide](system1-config.md#enable-and-use-each-feature).
Merge this section into `consumers`, preserving existing provider configuration
and other consumers:

```json
{
  "consumers": {
    "contextCompaction": {
      "mode": "automatic",
      "remoteContextApproved": true,
      "earlyOpportunityPercent": 60,
      "limits": { "timeoutMs": 1000, "maxStateBytes": 8192 }
    }
  }
}
```

This is a fragment, not a complete replacement file. The existing System1 feature
must be selected and its configured provider key available **to the parent only**.
Restart the session after human-owned configuration changes. `mode: "off"`, missing
consent/config/key, invalid consumer config, unavailable service or timeout disables
only semantic assistance. No config, consent, runtime upgrade or activation is
automatically performed by D7 implementation.

The semantic opportunity defaults to 60% and may be configured only within 50–70%.
The 70% deterministic target does not wait for System1. These are operator policy
thresholds, not a measured optimum. Eligibility
also requires compactable history beyond Pi `keepRecentTokens`, response headroom,
a changed snapshot and actual growth after the previous compact. Headroom uses
Pi's effective `compaction.reserveTokens` (default 16,384), capped by the model's
maximum output, rather than reserving that entire theoretical maximum. This keeps
early opportunities possible for models such as 272k-context / 128k-output.
The bounded assessment is awaited at the safe turn boundary so another model
request cannot immediately invalidate its snapshot. Jev choice confidence is
validated locally with provider provenance; its unsupported optional
`provider_confidence` capability is not required to admit the request.
Unknown usage
never becomes a guessed percentage. Provider-reported confidence must be at least
**0.80** for the safe-boundary decision. Uncertain or unknown retention uses the
standard preservation instructions rather than vetoing a confidently safe boundary.
Both confidence values are recorded as numbers (or null), without provider text.
Advice cannot defer mandatory pressure recovery. The production turn-end handler
awaits the bounded assessment before another model request.

## Use

Continue using normal tasks, specialist dispatches, research and nested delegation.
For explicitly requested manual compaction, use the existing `request_compaction`
tool with `customInstructions`, `reason` and optionally `continuationPrompt`.
Existing approval and budget gates remain authoritative after recovery.

Inspect the existing context-budget view for measurements and recovery phases.
The communication view captures only question IDs, byte counts, status and validated
decision enums for `context-compaction/questions/v1`. It does not capture task text,
questions, raw responses, free-form summary or credentials. Semantic snapshots are
bounded task/turn measurements, not full transcript or raw tool output. Consent is
specific to this consumer.

Each Hub turn also records `agent-hub-context-assessment` metadata: measured usage,
reserved headroom, status, reason and whether inference was requested. Reasons
include `below_early_threshold`, `no_compactable_history`, `insufficient_headroom`,
`service_unavailable`, `unsupported`, `timeout`, `low_confidence` and `safe_boundary`.
These diagnostics never include task text, retention instructions or raw errors;
the existing status line exposes the last status/reason. They do not claim that a
provider call occurred when eligibility or service capability rejected it.

## Observed live behavior and scope

A live `orchestrator2` coms test reached 90% pressure, compacted from 245,830 tokens,
restored the Hub state and received a runtime custom continuation. It then read
`system1-report.ts`, `system1-activity.ts` and `context-budget-hub-prompt.ts` without
a new user/coms request and finished with `D7_AUTO_COMPACTION_AND_CONTINUATION_FINISHED`.
The session recorded 16 early assessment requests: 15 rejected as `low_confidence`
and one as `snapshot_changed`. This proves live pressure fallback + continuation,
**not** a live compact selected by accepted semantic advice. This historical trace predates per-answer confidence diagnostics; current local
assessment records include boundaryConfidence and retentionConfidence.

| Managed path | Local pressure adapter | Early semantic assistance / proof |
| --- | --- | --- |
| Hub | Supported Pi coordinator; live compact/continuation observed | Automatic requests observed; accepted safe advice → compact verified with guarded fake provider |
| Native specialist | Shared physical spawn loads child adapter | Parent context channel implemented; writable child fixture passed |
| Research/recon | Same physical spawn adapter | Read-only child fixture passed; full production research flow still needs acceptance coverage |
| Nested delegate | Same adapter on descendant physical spawn | Root shared-service forwarding through all process levels is incomplete |
| Workflow scout | `runAgentPhase` uses the shared physical spawn | Separate workflow process does not have guaranteed root Hub System1 service forwarding |
| External peer | No D7 remote control adapter | Remains usable/native-managed; unknown external context is not fabricated 0% |

The role name does not determine coverage: the physical spawn path and ownership do.
Each native child measures its own model window and continues in the same attempt;
this is not a kill/re-dispatch or a fresh task budget.

**Known semantic limitations:** `coms-inbound` is a custom message and currently does
not update the D7 task-description snapshot like accepted interactive input does.
Thus a coms-run assessment may see stale/minimal task text. Child assessments use a
generic non-exporting task description. Root-service forwarding for nested/workflow
processes is not complete. Do not lower confidence thresholds to mask these gaps;
coms operation binding and full descendant end-to-end proof are remaining work.

## Verification and current limits

```sh
npm run test:context-continuity
node --test bin/test/context-continuity-installed.test.js
npm run typecheck:hub
npm run test:system1
npm run test:fast
```

All new D7 test commands preload the network-denial helper or launch guarded fake
provider subprocesses. The installed test extracts the npm package and uses its
runtime modules without source-tree imports.

The common physical adapter is tested on writable specialist and read-only child
surfaces. Full production research/nested end-to-end simultaneous parent/child
compaction, persisted cancellation mid-compaction, the installed legacy-runtime
matrix, peer fixtures and exhaustive unchanged-budget ledger proof still require
the corresponding acceptance coverage listed in the D7 plan. Do not interpret
module presence or a successful compact callback as completion of those cases.
The implementation is not a live deployment and does not upgrade runtimes.

Latest local verification after launcher/low-pressure/new-task/small-session/headroom fixes:
90 D7 tests passed; the installed package's 12 real-Pi fixture cases passed through the bundled Pi symlink launcher (including explicit
compaction at ~1.6% usage and two separate tasks in one RPC session with an
explicitly confirmed task supersession, plus an honest skip with default Pi
retention and a real automatic hook using the shared fake Jev transport at ~66–70%
with 272k context / 128k max output and default Pi reserve); 428 fast tests passed; System1 suite and Hub typecheck passed.
70 focused spawn/registry/bridge/context-budget regression tests passed. The broader
file-discovery suite exceeded the command's 120-second timeout and is **not**
reported as passed. The plan and canonical Hub/architecture documentation still
need final acceptance reconciliation once the remaining integration cases close.


## Automatic compaction monitoring

`/af-context` retains the existing context-budget overlay and adds automatic policy
and last-recovery rows. The status line shows the target and ceiling. Hub records
`agent-hub-compaction-monitor`; native children record `agent-fleet-compaction-monitor`.
Events distinguish `started`, `restored`, `continuation_requested`, `continued`,
`failed`, and `ceiling_blocked`,
with an episode, before/after percentages and ceiling overshoot. Since Pi reports
unknown usage immediately after compaction, the reduction stays unknown until the
first subsequent measured response; that event is marked `first_post_compaction`.
A queued continuation becomes `continued` only on that post-summary measurement.
Assessment skips and low confidence remain in `agent-hub-context-assessment`.
The monitors are local to execution, not a separate polling model or user approval.

A single large tool result can jump over a threshold. The runtime observes that
result, records the overshoot and interrupts before the next ordinary model request.
It cannot guarantee that every received result fits below 80%. If usage is still
at/above 80% after an unsuccessful or insufficient recovery, it blocks further work
instead of repeatedly compacting or silently exceeding the ceiling. Recovery never
replays effects, fabricates new user input, or overrides cancellation/permissions.

Current acceptance uses the installed Pi 1.3.0 CLI, actual tools, actual Pi summary
preparation and persisted compaction entries. Provider responses and usage are
controlled offline fixtures, including delayed System1 advice, so threshold tests
are reproducible without external inference. This verifies runtime behavior, not
live-provider summary quality or confidence calibration.
