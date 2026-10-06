# Unified System 1 configuration

System 1 runtime settings live only in the human-owned `.ai/system1.json` v2 document. Installation selection remains in `.ai/agent-fleet.json` and installer state. Selection is not runtime activation, remote-context consent, or calibration approval.

## Safe starting configuration

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
| `fileDiscovery` (D9) | `mode: off` or `active`; independent `remoteContextApproved`, nonempty `include` for approved active use, bounded `limits`; automatic full-list ranking |

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

For a separately approved Git-tracked-only export scope, set only `consumers.agenticAsk.include` to `["git:tracked"]`. This dynamically checks the current Git index before reading sources and for freshness; selected text is from the working tree. Untracked files do not qualify, and sensitive-path/local-access/source guards still apply even to tracked files. It does not change `fileDiscovery` consent or output capture. Adding directory prefixes alongside the selector also permits their untracked descendants. See [D10 export scope and refusal handling](system1-agentic.md#export-scope-and-gittracked). Restart the Hub after editing.

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
