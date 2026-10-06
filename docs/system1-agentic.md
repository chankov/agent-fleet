# Agentic System 1 — `ask_system1`

Opt-in provider-neutral advisory tool for the **parent Agent Hub** in operator and orchestrator modes. It batches model-authored `choice`, `predicate`, and `ordinal` questions through the existing System 1 service. It does not execute commands, grant permissions, change task tiers or close acceptance, assertion, plan or review gates. Advice never replaces reading before editing or independent review.

## Enable deliberately

The default install does not enable this consumer. The existing System 1 feature must be selected in the workspace; a preserved consumer config cannot re-enable a disabled feature. Use the existing System 1 setup and the shared `.ai/system1.json` v2 document; there is no second config file or independent switch. `agenticAsk` needs its own explicit remote-data consent, even when another consumer is approved. Keep any other consumer sections intact.

```json
{
  "version": 2,
  "mode": "auto",
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "apiKeyEnv": "TYPESAFE_API_KEY",
  "consumers": {
    "agenticAsk": {
      "mode": "recommended",
      "remoteContextApproved": true,
      "include": ["src", ".pi/harnesses"],
      "allowToolOutputs": false
    }
  }
}
```

This is an opt-in example, **not** an installed default. The provider credential remains managed by the existing System 1 setup. Do not place credentials in state, questions, files or outputs. Missing/off/unapproved consumer means zero source capture and evaluation calls. Invalid configuration fails closed. To disable, set `consumers.agenticAsk.mode` to `off` and restart the session. No live inference or remote consent is required to install the runtime.

## Usage policy

| `consumers.agenticAsk.mode` | Behavior |
|---|---|
| `off` (or absent section) | No capture or evaluation; tool unavailable. Installed default. |
| `advisory` | Available when approved; the Hub chooses when an optional consultation helps. |
| `recommended` | Available when approved; the Hub is instructed to call first for suitable bounded semantic judgments. |

`recommended` actively favors `ask_system1` for classification, selected-file relevance/scope, risk and assumptions, request clarity and failure interpretation. These are examples, not an exhaustive allowlist. It applies to **all task tiers, including trivial/small**, in both work modes, without waiting for the user to request a call. The model selects permitted paths/ranges directly when that avoids reading whole files into its own context just to make the same judgment.

For matching judgments it is the exclusive first route before extended independent reasoning or research for the same question. Exact lookup/search/calculation, gathering missing facts, required reading before editing, tests, independent review and user decisions still use their appropriate tools. Dedicated task/dispatch triage and review workflows remain separate obligations; `ask_system1` cannot satisfy their gates.

The routing policy treats useful calls as **free and fast**: no financial rationing and no invented “one or two calls per task” quota. Batch related independent questions, reuse current answers, and avoid repeat calls to obtain agreement. This is an operator preference, not a measured price/latency claim; diagnostics still report actual usage or unknown. The technical session cap, timeouts and input bounds below remain in force.

Refusal, unavailable service, missing evidence, stale/inconclusive advice or an exhausted budget falls back to ordinary reading, research or independent reasoning without automatic retries. Modes do not expand consent, file scope, output capture or process authority. Results in both enabled modes retain `advisory: true`.

The recommendation is injected only when this consumer is in `recommended` mode **and the tool is active in the parent Hub catalog**. It is a prompt policy, not an automatic call hook or a guarantee of model compliance. Configuration is snapshotted at session initialization: start a new Hub session after changing the mode.

## Inputs and example uses

`ask_system1({ state?, paths?, evidenceRefs?, questions })` requires at least one source of state. Paths are explicit repo-relative files, optionally with inclusive `startLine`/`endLine`; no glob or recursive scan. Questions are typed JSON, not a stringified blob. IDs must be unique bounded identifiers. Every choice needs an `other` or `unknown` option. Predicate results are `probabilityTrue`, not invented confidence. Example:

```json
{
  "state": "BG: Защо резултатът е 42? EN: Why is the result 42?",
  "paths": [{ "path": "src/app.ts", "startLine": 1, "endLine": 30 }],
  "questions": [
    {
      "id": "request_kind", "type": "choice",
      "instructions": "Classify the request against the selected code.",
      "options": { "bug": "A defect", "expected": "Expected behavior", "unknown": null }
    },
    { "id": "clear", "type": "predicate", "instructions": "Are the requirements sufficiently clear?" },
    { "id": "risk", "type": "ordinal", "instructions": "Assess risk", "levels": ["low", "medium", "high"] }
  ]
}
```

- **A — failure triage:** a completed failing-test output ref plus selected code and task context. The evaluation is not test execution evidence.
- **B — diff risk:** an explicitly selected recorded diff ref. Low predicted risk does not waive review.
- **C — request clarity:** a BG/EN request plus code. A clear-request answer does not waive planner obligations.

For A/B, explicitly opt into `allowToolOutputs: true`. Only new completed normal Hub `bash` results are captured; there is no transcript scan, command repetition, internal shell or automatic evaluation. The tool result adds an opaque `ask1:…` ref. Pass it in `evidenceRefs` on a later call. Reliable exit/error/completeness metadata is preserved when provided; missing exit code is unknown. Partial outputs and errors without reliable completeness metadata are retained only as incomplete evidence and refused for inference. A normal bash result may already have reached the main model; this feature does not claim to intercept it before context.

## Sources, refusals and readback

### Export scope and `git:tracked`

`consumers.agenticAsk.include` accepts explicit repo-relative file/directory prefixes and the opt-in selector `git:tracked`. Prefixes authorize all descendants, including untracked files. `include: ["git:tracked"]` instead authorizes only paths present in the current repository's Git index (`git ls-files --cached`). New/staged files qualify; untracked/ignored files do not unless explicitly added to the index. Selected content is the **current working-tree file**, not the committed/index blob. A file removed from the index no longer qualifies. Submodule contents are not recursively enumerated.

```json
"agenticAsk": {
  "mode": "recommended",
  "remoteContextApproved": true,
  "include": ["git:tracked"],
  "allowToolOutputs": false
}
```

This is a deliberate repository-wide export opt-in, not a default. Git tracking does **not** certify that content is non-secret. Existing forbidden-path, credential, local-access, symlink, size, encoding and change guards remain. Tracked `.ai` configuration, credentials and session/runtime stores are still refused. Git membership is checked before source content reads and rechecked for freshness, using literal pathspecs without inherited Git repository/index overrides. A missing/failing Git lookup or a workspace that is not a Git repository root fails closed. Linked Git worktree roots are supported. Mixed selectors/prefixes are a union: adding `"docs"` beside `"git:tracked"` also authorizes untracked files under `docs`.

The selector is implemented only for `agenticAsk`; it does not enable other consumers or capture tool outputs. It is one include entry, not a file enumeration: per-call file/byte/question/session limits remain unchanged. No inference is triggered by configuration changes. Restart the Hub session after changing configuration.

Before a file-backed call, check the approved include scope without exposing credentials. Pass actual repo-relative file paths and selected line ranges in `paths`, **not** `git:tracked`. `include: ["."]`, `include: ["**"]` and absolute paths are not supported.

### Interpreting `source_denied`

`{"status":"unavailable","reason":"source_denied","advisory":true,"sourceSummary":[]}` is a **local input/source guard refusal**, not Jev's answer to the semantic question. The runtime validates input and collects approved sources before calling the provider; no provider judgment is produced for that refused call. An empty summary means collection did not successfully return source summaries; it does not identify which guard fired or prove that no local bytes were read (for example, the credential guard checks content).

Possible causes include a path outside `include`, local damage-control denial, forbidden/symlink/non-text sources, and credential-like input or file content. A selected range does not bypass whole-file safety checks or source-size limits. The `evaluationId` is a correlation identifier, not proof of inference, and `advisory: true` is the tool's authority boundary, not a success flag. Current configuration can explain a new refusal but does not prove the configuration or cause of a historical session, which uses its initialization snapshot.

Do not repeat an unchanged refused call, move/rename the source or paste denied source/output into `state` or `questions` to bypass export policy. Fall back to locally permitted reading/research. A state-only question is valid for independently permitted non-secret facts (for example, interpreting the public status code), but cannot evaluate unseen denied code. Any scope expansion requires a separate explicit human decision and a new Hub session.

Files must pass the **current local damage-control policy**, including `zeroAccessPaths`, before content reads. `include` grants export scope only, never local file-access authority. Symlinks/escapes, non-files, invalid UTF-8, binary data, oversized/changing sources and obvious credentials refuse rather than silently truncate. Source code in dot directories may be explicitly included; credential files, VCS metadata, session stores and runtime data cannot be exported. Pattern checks cannot detect every possible secret; operators remain responsible for selecting non-sensitive data.

Successful results contain `advisory: true`, a correlation `evaluationId`, validated answers/uncertainty, real provider metadata and `sourceSummary` with hashes, refs, selected ranges and coverage. **File/output bodies are not returned by this tool.** A selected range is marked incomplete relative to the full file but is a valid explicit selection. Missing usage is unknown, never zero; no USD prices or claimed savings are calculated.

File summaries use their repo-relative path for normal local readback: use `filesystem` stat, then excerpt within the existing self-read budget. Output summaries expose `readbackHandle`: use `filesystem` readback with that deterministic handle. Readback is still subject to current artifact/source-path policy, task/session binding and content hash. Known source paths are checked; arbitrary shell output cannot be claimed to reveal all source paths. Output handles are private, bounded, evicted oldest-first and removed on disposal. Replaced/evicted/cross-session refs are not recovered by scanning historical logs. Use `spawn_research`/dispatch when local readback exceeds the existing self-read limit.

Refusals include `consumer_off`, `not_approved`, `invalid_input`, `source_denied`, `source_changed`, `evidence_incomplete`, `evidence_unavailable`, `state_too_large`, `budget_exhausted`, and fail-closed counter/persistence errors. Provider `skipped`, `unavailable`, `unsupported`, and `cancelled` remain distinct. Cancellation discards late success; source/task changes make otherwise successful advice `stale`.

## Bounds and lifecycle

All values below are hard maxima; `limits` may only lower them:

| Limit key | Maximum |
|---|---:|
| `maxFiles` / `maxQuestions` | 20 / 16 |
| `maxStateBytes` / `maxQuestionsBytes` | 8192 / 16384 |
| `maxSourceBytes` / `maxRequestBytes` | 65536 / 131072 |
| `maxCallsPerSession` | 100 logical batches |
| `timeoutMs` / `collectionMs` | 2000 / 1000 |
| `maxHandles` / `maxRetainedBytes` | 20 / 1048576 |

Limits use serialized UTF-8 **bytes**, including questions/framing. Overflow returns a size breakdown where available, without automatic splitting or truncation. Call reservations persist before inference and survive task resets/resume/compaction; retries belong only to the shared provider adapter and are reported as actual attempts. Missing/corrupt historical counter state fails closed. A genuinely new session starts a new budget; task changes do not. Evidence references intentionally do not survive runtime disposal/resume; the persisted budget does.

Native worker tools do not receive this capability. Hub-spawned peer sessions carry a child marker and cannot inherit it. Active tool availability is refreshed through the existing core capability/work-mode resolver, not through a second enable flag. Tool visibility is not process-gate admission.

## Diagnostics and local proof

The existing Fleet System 1 communication viewer remains explicitly enabled by the operator. Its `agenticAsk` projection contains owner/model, status, counts/bytes, latency, attempts and real usage or unknown. It omits state, file/output bodies, dynamic question text, IDs, labels and answer values. Unrecognized shapes stay withheld; observer failures cannot change inference. Stale/cancelled replies cannot become successful rows when a provider completes late.

Run `npm run test:agentic`, `npm run test:system1`, `npm run test:task-triage` and `npm run typecheck:hub`. Tests use deterministic fake answers, temporary artifacts and a no-network guard; installed-package tests verify the worker/schema import closure. These prove engineering integration, **not** semantic accuracy, calibration, latency savings or financial acceptance.

See [System 1 dispatch triage](system1-dispatch-triage.md) and [architecture](ARCHITECTURE.md) for the existing process boundaries.
