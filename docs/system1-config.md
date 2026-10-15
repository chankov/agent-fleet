# Unified System 1 configuration

System 1 runtime settings live only in the human-owned `.ai/system1.json` v2 document. Installation selection remains in `.ai/agent-fleet.json` and installer state. Selection is not runtime activation, remote-context consent, or calibration approval.

## Safe starting configuration

[system1.example.json](system1.example.json) is a valid, commented-in-this-guide
reference for System 1 settings. The v2 schema now supports **eight root
consumers**, including D7 and D6; the inert D6 fragment below documents that
section separately without changing the example file.
It is inert: root and consumer modes are `off`, remote consent is false/disabled,
and no key value is included. Runtime reads `.ai/system1.json`, **not** this example.
The example is shipped as documentation; it is not installed as active consent.

For a new workspace with no existing runtime document:

```sh
# Only if .ai/system1.json does not exist; do not overwrite human configuration.
mkdir -p .ai
if [ ! -e .ai/system1.json ] && [ ! -L .ai/system1.json ]; then
  cp docs/system1.example.json .ai/system1.json
fi
```

In an existing workspace, merge only the reviewed sections into your current
`.ai/system1.json`. Do not replace it wholesale. The `include` roots in the example
are for this Fleet checkout; substitute your project's separately approved roots.
No example calibration profile or rule hash is invented: `dispatchTriage.profile`
is omitted and `proactiveReview.localBindings` is empty until independently reviewed.
The dispatch byte/call values are illustrative (not calibrated production budgets);
D10/D9 limits show supported defaults/maxima; Task Triage limits are exact pins.
Most default limit fields can be omitted, but do not omit required dispatch fields
or alter the Task Triage pins.

A smaller provider-only starting point is:

```json
{
  "version": 2,
  "mode": "off",
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "apiKeyEnv": "TYPESAFE_API_KEY",
  "consumers": {}
}
```

The key value belongs only in the process environment, never JSON. There is no provider fallback. Consumers share one service and one immutable configuration snapshot per session; edits take effect in a new session, not through hot reload.

## Consumers

Each optional section under `consumers` has its own permissions and budgets. Missing sections are off. Consumer file `version: 1` wrappers are not included in v2; semantic policy, question, profile and local-binding versions remain.

| Section | Settings |
| --- | --- |
| `watchdog` | `mode: off`, `shadow`, or `active`; existing pinned experimental scope-only profile remains unchanged |
| `proactiveReview` | `mode: off`, `shadow`, or `advisory`; `remoteContext`, explicit `include`, `maxEvaluationsPerSession`, optional reviewed `localBindings` |
| `dispatchTriage` | `mode: off`, `shadow`, or `advisory`; explicit `remoteContextApproved`, positive `maxCalls`, `maxStateBytes`, `maxTaskBytes`, `maxRoleBytes`; optional `profile`, `orchestratorBeforeDispatch` |
| `taskTriage` | `mode: off` or `experimental`; explicit `remoteContextApproved`, pinned `questionVersion`, `policyVersion`, `limits`; inherits root provider/model |
| `agenticAsk` (D10) | `mode: off`, `advisory`, or `recommended`; independent `remoteContextApproved`, `include` (repo-relative prefixes or explicit `git:tracked` selector), `allowToolOutputs`, `limits`; parent-only typed judgment tool |
| `fileDiscovery` (D9/D8) | `mode: off` or `active`; independent `remoteContextApproved`, nonempty `include` for approved active use, bounded `limits`; optional `semanticReads: {mode: off | active}` (default off); automatic full-list ranking and opt-in orientation |
| `damageGuard` (D6) | `mode: off` or `active`; independent boolean `remoteScopes.commands/edits/results`, explicit `include`, bounded `limits`; optional semantic checks over mandatory baseline, not permission authority |
| `contextCompaction` (D7) | `mode: off` or `automatic`; independent `remoteContextApproved`, `earlyOpportunityPercent` (default 60, below 80), `limits.timeoutMs` (maximum/default 1000), `limits.maxStateBytes` (maximum/default 8192); automatic early-boundary advice, not a compact tool |

The top-level `mode: off` disables remote inference. Independently valid proactive local capture/checks can remain enabled. An off proactive section cannot authorize capture. Neither off nor migration failure/provider unavailability cancels persisted Task Triage process obligations.

Example task section (requires separate human data consent):

```json
{
  "mode": "experimental",
  "remoteContextApproved": true,
  "questionVersion": "task-triage/questions/v1",
  "policyVersion": "task-triage/policy/v1",
  "limits": {
    "maxTaskBytes": 40960,
    "maxStateBytes": 65536,
    "maxCallsPerSession": 100,
    "timeoutMs": 2000
  }
}
```

Those task limits are a pinned compatibility contract, not adjustable knobs. Profile thresholds for dispatch remain configurable. D10 and D9 are implemented consumers of the same v2 service, not extra providers or config files. Example sections below require separate human consent and workspace-specific roots; this is not activation:

```json
{
  "agenticAsk": {
    "mode": "recommended",
    "remoteContextApproved": true,
    "include": [".pi/harnesses", "bin", "docs"],
    "allowToolOutputs": false
  },
  "fileDiscovery": {
    "mode": "active",
    "remoteContextApproved": true,
    "include": [".pi/harnesses", "bin", "docs"]
  }
}
```

Merge these under `consumers`, preserving root settings and all human-owned sections. D10 recommended is model-facing advice for suitable typed questions; it does not activate D9 or grant D9 export consent. D9 uses deterministic discovery/pre-spawn hooks, retains every display-permitted candidate (including low/unscored), and pages large results without raising read budgets. Its complete/partial/unavailable/cancelled/skipped and independent discovery/evaluation coverage are not semantic accuracy guarantees. Start a new session after edits. See [D10](system1-agentic.md) and [D9 triggers, full-list contract, limitations and unpublished source/local-tarball commands](system1-file-discovery.md).

D8 automatic semantic orientation is separately opted in with `consumers.fileDiscovery.semanticReads: {"mode":"active"}`. Missing/off preserves D9. It shares D9 consent/include/read guards and scheduling/budgets; D10 consent does not activate it. Eligible singleton discovery, repo-file stat and single-file native pre-spawn receive a versioned orientation pack with a 2000 ms foreground bound. Raw reads and mandatory evidence remain unchanged; failures preserve ordinary permitted operations. Multi-file D9 requests include orientation without a second evaluation. Explicit typed questions are never truncated to make room. See [D8 runtime contract](system1-file-discovery.md#automatic-semantic-reads-d8).

For a separately approved Git-tracked-only export scope, set only `consumers.agenticAsk.include` to `["git:tracked"]`. This dynamically checks the current Git index before reading sources and for freshness; selected text is from the working tree. Untracked files do not qualify, and sensitive-path/local-access/source guards still apply even to tracked files. It does not change `fileDiscovery` consent or output capture. Adding directory prefixes alongside the selector also permits their untracked descendants. See [D10 export scope and refusal handling](system1-agentic.md#export-scope-and-gittracked). Restart the Hub after editing.

## Enable and use each feature

1. Select the existing **`system1`** installation feature using normal setup. For
   Task Triage, also select **`system1-task-triage`** and review its separate consent.
   Selection alone does not enable inference or grant remote-context approval.
2. Supply `TYPESAFE_API_KEY` through your normal parent process environment. Never
   put the value in JSON, chat, source control or child assignments.
3. Review provider/root settings and change root `mode` to `auto` only when ready
   for remote inference. Then enable only the desired consumers with their own
   consent and scopes. One consumer's consent cannot enable another.
4. Stop and restart the Pi/Hub **process** after config or extension changes. A new
   conversation inside an old process is not a reliable code/config reload.
5. Use the offline doctor before launching. From this checkout, for example:

```sh
node bin/cli.js doctor --workspace "$PWD"
```

The following are edits to existing sections **after human review**, not commands
that change consent. Keep other sections off if you do not need them.

| Feature | Opt-in changes | Example use / observable behavior |
| --- | --- | --- |
| Watchdog System1 | `watchdog.mode: shadow` (or separately reviewed experimental `active`); keep the underlying drift watchdog armed | Dispatch an authorized specialist normally; System1 assists watchdog observations. `/af-watchdog` shows readiness. `active` is experimental scope-only, not general calibration acceptance. |
| Proactive review | `proactiveReview.mode: shadow` or `advisory`, nonempty approved `include` such as `["docs/**"]`, `maxEvaluationsPerSession` such as 20; `remoteContext: selected-excerpts` only for approved export | A normally authorized edit triggers local turn capture/review. `shadow` observes; `advisory` can deliver findings. `remoteContext: disabled` retains permitted local capture/checks without exporting excerpts. |
| Dispatch triage | `dispatchTriage.mode: shadow` or `advisory`, `remoteContextApproved: true`; review the explicit call/byte budgets | Ask the orchestrator to use `dispatch_triage(task, scope, language, domain)` before independently dispatching. Without a matching approved `profile`, expect `uncalibrated`, not a calibrated persona recommendation. `orchestratorBeforeDispatch: true` adds instructions, not an automatic launch hook. |
| Task triage | `taskTriage.mode: experimental`, `remoteContextApproved: true`, unchanged pinned question/policy/limits | Submit a normal user task; runtime assesses the accepted input before model work. Process obligations remain authoritative even after inference is turned off. |
| Agentic Ask (D10) | `agenticAsk.mode: advisory` or `recommended`, `remoteContextApproved: true`, reviewed `include`; keep `allowToolOutputs: false` unless separately approved | Ask a focused typed question, e.g. `ask_system1` with a choice about the relevance of a selected `docs/` range. `recommended` encourages first-use routing; answers never execute work or satisfy gates. |
| File discovery (D9) | `fileDiscovery.mode: active`, `remoteContextApproved: true`, approved nonempty prefix `include` | Use normal permitted `filesystem` inventory/find/ls/grep or native pre-spawn discovery. Runtime ranks candidates while retaining every display-permitted result, not only top-K. |
| Semantic reads (D8) | Additionally `fileDiscovery.semanticReads.mode: active` | Normal eligible single-file stat/discovery receives orientation through the same D9 service/consent. It is not another root consumer or a replacement for reading evidence. |
| Context compaction (D7) | `contextCompaction.mode: automatic`, `remoteContextApproved: true`; keep 60% early opportunity and bounded limits initially | Continue a normal long task. Runtime asks System1 at eligible changed turn boundaries; a safe/confident retained answer can request early compact. Deterministic 70% recovery (80% ceiling) does not require System1. |

### D7 opt-in fragment

Merge only this reviewed section under `consumers`:

```json
{
  "contextCompaction": {
    "mode": "automatic",
    "remoteContextApproved": true,
    "earlyOpportunityPercent": 60,
    "limits": { "timeoutMs": 1000, "maxStateBytes": 8192 }
  }
}
```

D7 uses Pi's effective compaction reserve for headroom, not the entire model
maximum output. `boundary = safe` must have provider confidence at least 0.80. Uncertain retention
uses standard preservation instructions; timeout/low confidence/stale advice leaves
the deterministic 70% pressure recovery available. Pi writes the summary; System1 does not compact,
delete history, reset budgets or grant permission.

Open the existing Fleet communication view (`1`, then enable capture with `e`)
**before** submitting work to observe System1 request/response metadata. D7 also
records `agent-hub-context-assessment` status/reason/measurement metadata and the
`context-assessment` status line. Capture never includes D7 task text, questions,
free-form summary or raw provider extras. Missing diagnostics on the model's tool
surface is not a reason to stop the permitted task.

Useful live prompts:

> **Short explicit test:** Read README.md once, then use `request_compaction` with
> a continuation that reads package.json once. Do not edit files or run shell.
> If there is no compactable history, report the runtime's honest skip and continue;
> do not claim an actual compact. Finish with `D7_EXPLICIT_FINISHED`.

> **Automatic test:** Continue one read-only comparison of new, distinct permitted
> documents/runtime source files. Check sizes and honor all guards/budgets. Do not
> use `request_compaction`, `/compact` or `ask_system1` to request compaction. Do not
> reset the task or stop at an arbitrary file count. Continue until real automatic
> compact or a concrete runtime refusal/cancellation/exhaustion of permitted sources.
> After automatic compact, read two further unread files without my `continue` and
> finish with `D7_AUTO_COMPACTION_AND_CONTINUATION_FINISHED`. No edits, padding,
> duplicate reads, tests, installs or permission changes.

60% is eligibility, not a guaranteed compact threshold. In the observed live Hub
run, early System1 advice was rejected for low confidence/staleness; 90% pressure
compact restored and continued successfully. Coms task-description binding and
root-service forwarding to nested/workflow processes remain incomplete: do not
claim full semantic assistance for every descendant merely because the shared
native pressure adapter is loaded. See [D7 scope, diagnostics, evidence and current
limits](system1-context-continuity.md). External peers do not gain remote compact
control.

### D6 independent off-by-default section

D6 is implemented in the current worktree but remains incomplete/unaccepted.
This inert fragment describes its section under `consumers`; it is not an
activation/copy/install instruction:

```json
{"damageGuard":{"mode":"off","remoteScopes":{"commands":false,"edits":false,"results":false},"include":[]}}
```

There is no D6 `remoteContextApproved` field and no inherited D8/D9/D10 consent.
Missing scopes grant nothing. Missing/off/invalid/root-off/unavailable-key means
no new D6 inference, not removal of durable denial/hold/recovery fences.
`include` is an explicit export scope; `git:tracked` is a selector example, not
blanket filesystem approval or active consent. Limits default/max out at 16 KiB
payload, 64 KiB IPC frame, one 2 s collection/IPC/inference deadline, 5 s technical
backoff and a separate 10 min human wait. The parser accepts smaller positive
safe integers; broker/client also impose fixed transport bounds. There is no
financial quota or upward-limit configuration. See the [D6 guide](system1-damage-guard.md)
for actual native coverage, standalone/coms limits, durable deny and dialog-only
override, original→D6→D8 structured output, SDK 1.1.0 evidence and open gates.
D6 is not activated by the feature instructions or other consumer examples above;
F12 packaging, independent review and final acceptance remain open.

## Explicit migration

Preview and apply are local CLI operations; neither starts inference nor grants new data consent:

```sh
agent-fleet setup --workspace /path/to/workspace --migrate-system1-config --dry-run
agent-fleet setup --workspace /path/to/workspace --migrate-system1-config --expect-digest <digest-from-preview> --yes
```

Preview shows the exact v2 target, changed paths and a digest without writes. Apply requires `--expect-digest` from that preview: it refuses even formatting-only input changes between separate CLI invocations. A stale digest exits with conflict code 3 and requires a new preview. Apply also uses the existing workspace lock, preview fingerprints, durable journal and rollback machinery. It retains a protected byte-exact backup under `.ai/.agent-fleet-recovery/<id>/backup/`; its location is included in the result. Keep this backup private and available for operator-led restoration. A successful migration removes the three legacy JSON files and only the recognized `watchdog-system1` key in the legacy `## agent-hub` / `## agent-team` overrides section. Heading/key case follows the old reader; repeated keys across either section refuse migration. Other Markdown bytes remain unchanged. Retained backup directories include a private `.gitignore` so normal Git staging excludes their content; doctor lists them without reading or deleting the backup files.

Malformed input, duplicate JSON/Markdown keys, unknown fields, symlinks, conflicting provider/model settings, and v2 plus legacy leftovers refuse migration without partial changes. A missing provider is never inferred from a consumer file. A clean v2 document is a no-op; repeated migration does not destroy the successful backup. Interrupted pre-commit changes roll back; `doctor --fix` performs existing journal recovery after a crash. Committed recovery keeps the successful migration backup.

### Consumer-only legacy workspaces

If `.ai/system1.json` is missing, migration refuses to choose a provider/model, even when legacy consumers exist. Doctor reports this case even when the feature was not selected. No files are changed. For local-only recovery:

1. Keep a private, untracked byte-exact backup of all legacy files and the overrides Markdown.
2. Explicitly review the pinned provider/model in the safe v2 example above and manually author `.ai/system1.json` with root `mode: "off"` (no remote inference).
3. Copy reviewed legacy policies into `consumers.proactiveReview`, `consumers.dispatchTriage`, or `consumers.taskTriage`, removing only each file's `version: 1` wrapper. For taskTriage, first verify legacy provider/model equal the root pins, then remove those two duplicate fields. Preserve modes, budgets, consent, profile and local-binding values. Add a single reviewed `consumers.watchdog.mode` from the recognized legacy Markdown setting if present; do not resolve duplicates or conflicts by guessing.
4. Run offline `doctor` and inspect all section errors. A valid proactive shadow/advisory section preserves local capture with root off. Leave remote inference off until separately authorized.
5. After validation, explicitly archive the legacy source files/settings with your private backup; runtime never reads them. Do not run the automatic migrator on mixed v2 plus legacy leftovers: it intentionally refuses that conflict.

Runtime does not fall back to `.ai/proactive-review.json`, `.ai/dispatch-triage.json`, `.ai/task-triage.json`, or the Markdown System 1 mode. A v1 provider document reports `migration_required` and produces no new System 1 requests. Doctor is offline/read-only for configuration: it reports root/section field paths and unused legacy files, without printing key values or automatically migrating.

## Setup and evaluation

`setup --features system1-task-triage --task-triage-consent --yes` proposes a single v2 document when missing, or adds a missing task section while preserving existing valid human-owned sections and root mode. Existing sections are not silently rewritten. Adding a missing section serializes the JSON document again: a dry-run includes a `changes` summary with the added pinned task section, preserved root mode and preserved existing consumer policies, plus `formattingChanged: true`. Review these semantic changes and the formatting warning before consenting; private human configuration/write buffers are not printed. `--yes` alone is never data consent. Deselecting the feature records a selection veto without erasing the configuration.

The demo uses the same loader; its default mode is offline readiness. Dispatch evaluation keeps separate offline corpus/config fixtures. Live dispatch evaluation reads `consumers.dispatchTriage` from the workspace v2 snapshot and requires explicit corpus consent and call/time budgets; an offline fixture cannot override production permissions.

No live accuracy, calibration, publish, or deployment is implied by local tests.
