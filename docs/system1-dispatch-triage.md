# System 1 dispatch advice and communication viewer

## Status and boundaries

The offline implementation is available. No live evaluation, human-labelled real
corpus or production calibration acceptance is claimed. The human has tested and
accepted the Fleet communication viewer.
Provider/consumer settings are human-owned. Existing v1 settings require explicit
migration before optional orchestrator-led triage can run.

`dispatch_triage` is an optional **orchestrator tool**, not a human slash command
and not an automatic before-dispatch hook. It never starts an agent, changes tier,
permissions, budgets, or satisfies acceptance. `dispatch_agent` retains all gates.

The tool accepts `task`, `scope`, `language`, and `domain`. It derives candidates
from the current roster, excluding research personas, busy specialists, and roles
blocked by current process, tier, review, documentation-lane and budget checks.
These are advisory snapshots, not reservations. Dispatch always checks again.
Use minimal non-secret context, never credentials, transcripts or file contents.
Credential-like text is refused before inference; absolute paths are replaced with
`[PATH]`, while project-relative paths remain available as scope context.

## Human-owned configuration

The existing selected `system1` feature and `.ai/system1.json` provider readiness
are necessary. The triage consumer reads `consumers.dispatchTriage` from the same
v2 session snapshot; see [unified configuration](system1-config.md). Missing/invalid configuration is off. Changes require
a new session; there is no model-facing tool to enable it.

Configuration fields:

| Field | Required value |
| --- | --- |
| document `version` | `2` at root; no consumer wrapper version |
| `mode` | `off`, `shadow`, or `advisory` |
| `remoteContextApproved` | Explicit human boolean consent |
| `maxCalls` | Human-approved positive integer, session logical-call ceiling |
| `maxStateBytes`, `maxTaskBytes`, `maxRoleBytes` | Human-approved positive byte limits; overflow refuses, never silently truncates |
| `profile` | Optional human-approved calibration profile |
| `orchestratorBeforeDispatch` | Optional boolean, default false. In orchestrator mode, when advisory/consent/service/budget are ready, instruct the orchestrator to triage each focused delegation before independently dispatching. No code-owned auto-launch. |

No arbitrary production budgets or quality thresholds ship. The communication
viewer's limits below are separate from triage call/context budgets.

A profile contains `version: "dispatch-triage/v1"`, `approved: true`, a nonempty
`evidence` reference, `provider`, `model`, nonempty `languages` and `domains`, and
probabilities `minConfidence`, `minMargin`, `securityThreshold`,
`destructiveThreshold`. All must match the evaluated context/provider/model.
Approval in this human-owned file is an attestation, not automatic validation of
the referenced evidence. Test fixture profiles are **not** approved live profiles.

Without an applicable profile, results are `uncalibrated`, not a recommendation.
An approved policy can return `suggest_persona`, `abstain` (`none`), or
`needs_judgment`, plus independent `consider_security_review`,
`consider_human_confirmation`, and `consider_decomposition` warnings.
Low risk probabilities **never** mean safe or remove checks. Provider confidence
is not a calibrated workflow success probability. Invalid results, stale snapshots,
missing context and unavailable services stay explicit.

`shadow` records metadata without returning advice to the orchestrator. One request
uses one shared service evaluation; physical retries remain adapter-owned. Separate
session limits apply; task changes do not reset the triage call counter. Session
shutdown aborts pending triage. Changed task/roster/constraints invalidate advice.

Metadata-only `agent-hub-triage` session entries record evaluation ID, fingerprint,
status, uncertainty, risks and policy/provider versions. No task payload is logged
there. `dispatch_agent` optionally accepts `triage_id` and `triage_reason` (`used`,
`better_fit`, `changed_scope`, `independent_judgment`) for explicit disposition.
Correlation is rejected when stale. The subsequent observation records a submitted
call, **not proof of launch or success**; dispatch evidence owns those facts. No
correlation is inferred merely from matching persona names.

## Testing the enabled repository experiment

Legacy repository configuration is not automatically migrated. Run the explicit
[local migration](system1-config.md#explicit-migration), review the target modes,
consent and budgets, then start a new session. v1 gives `migration_required` and
makes no System 1 calls. No calibration profile is invented by migration.

Start a new session with an explicitly selected System 1 feature and the current
process key. Never paste the key into chat.

Open Fleet, press `1`, then `e` before submitting a task. Ask the orchestrator to
delegate a read-only code review of `.pi/harnesses/agent-hub/ui/system1-communication.ts`,
without modifying files. After its normal task/process classification, expect
`dispatch_triage` followed by an independently chosen `dispatch_agent` with a
`triage_id` and truthful `triage_reason`. `uncalibrated` is expected, not an error.
The viewer should show the triage request/response. Empty roster, process restrictions,
missing service, credential-like context or exhausted budget produce explicit skips;
no automatic retry loop or gate bypass is introduced.

To disable: set `mode` to `off` and start a new session. To keep optional tool use
but stop routine pre-dispatch instructions, set `orchestratorBeforeDispatch` false.
Capture is independent: `d` clears/disables it. No live evaluation was run while
making this activation change.

## Fleet communication viewer

- **`1`** on the Fleet Dashboard or explicitly active Fleet strip opens the viewer.
  `j`/`k` navigation is unchanged. Editor, filter, paste and other modal input are
  not intercepted. The Dashboard works with no active agents.
- **`e`** explicitly enables session-only capture; **`d`** disables and clears it.
  Capture is off initially. Opening the panel does not enable inference or capture.
- One row is one logical request or response. **Enter** on either opens the pair.
  Pending requests appear before their response. IDs handle out-of-order completion.
- In detail, **left/right** select Copy request / Copy response; **Enter** copies.
  Arrows, PgUp/PgDn/Home/End scroll; **Esc** returns to the list, then Fleet.
- Copy uses the entire retained sanitized JSON, not just the visible viewport.
  Missing, withheld or evicted payloads cannot be copied as successful data.

The session's shared service covers watchdog, proactive selection/assessment and
triage. Known v1 request schemas have allowlisted top-level projections; new schemas
are marked not instrumented and withhold payloads until reviewed. Other providers
can use the same service observer; there is no Jev-specific UI or second HTTP client.
Independent external peers/CLI processes are not globally intercepted.

This is a **sanitized logical service exchange**, not raw HTTP capture: no headers,
keys, environment, provider error bodies or arbitrary provider extras. Structured
secret-bearing fields and common secret text patterns are masked; unknown secrets
cannot be guaranteed detectable. Capture remains an explicit local debugging opt-in.
Never send secrets expecting redaction to make them safe.

Limits: **200 evaluation pairs, 4 MiB total, 32 KiB per serialized payload**.
Eviction removes pairs and reports a count. Oversized payloads are withheld, not
silently presented as complete. There is no disk spill or payload telemetry.
Closing the panel retains the current session buffer; disabling capture, session
close/switch or restart clears it. Resume starts empty. Compaction does not serialize
payloads. Old-session callbacks cannot refill a new buffer. Clipboard managers may
retain copied data independently; no clipboard-history erasure is promised.

## Offline and explicitly approved live evaluation

```sh
npm run test:triage
node .pi/harnesses/agent-hub/dispatch-triage-eval.ts --help
node .pi/harnesses/agent-hub/dispatch-triage-eval.ts --corpus CORPUS.json --config CONFIG.json
```

The corpus is a JSON array matching exported `TriageExample` in
`dispatch-triage-eval.ts`: stable `id`, related-task `group`, `split`
(`calibration`/`held-out`), `origin` (`synthetic`/`real-redacted`), `labelRevision`,
reviewer `rationale`, `remoteApproved`, input snapshot, and labels. `labels.personas`
is a set of acceptable answers, including `none`; security/destructive/decomposition
labels may be `null` (unknown). `baseline` is optional. Offline `replay` contains a
structured System 1 result; absence is reported, never fabricated. Test-only
synthetic examples live in `dispatch-triage.test.ts`, not a claimed real benchmark.

Related examples cannot cross splits. Review labels independently of suggestions;
freeze thresholds on calibration data before held-out evaluation. A modified profile
needs new independent evidence. Corpus digest and versioned reports support replay.
Reports include failures, unknowns, raw model correctness, advisory correctness,
coverage counts, baseline agreement, risk confusion matrices, latency/attempts/usage,
confidence/margin, and strata by split, origin, language and domain. Cost stays unknown
without trustworthy pricing; the evaluator never automatically approves calibration.

Live requires **separate human approval**, per-example `remoteApproved`, config
remote consent, explicit `--live --max-calls N --max-ms N --workspace DIR`, existing
provider configuration and environment credentials. No dotenv loader is added.
The runner refuses incomplete authorization before constructing the provider. This
implementation was tested offline only; do not enable live by copying fixture budgets.

## Outstanding acceptance work

Human-supplied/redacted real tasks and independently reviewed labels, numeric live
budgets, context limits, quality/missed-risk/latency criteria, approved calibration
and held-out results, and independent security review remain
necessary before claiming the complete live advisory rollout. The viewer can be used
independently of that rollout. Disable capture and set triage mode off to stop new
consumer activity; this never cancels or repeats an existing dispatch.
