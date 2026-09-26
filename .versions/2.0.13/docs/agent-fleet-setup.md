# Agent Fleet — Project Files

agent-fleet keeps a few small files in a project's `.ai/` directory. They have
different readers and different lifetimes, so they are kept separate.

| File | Read by | When |
|------|---------|------|
| `.ai/agent-fleet-overrides.md` | `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`, `compound-learning` (the `rules:`/`docs:` keys of `## agent-hub`), `agent-hub` pi harness | Every run of those skills / every session start of the harness |
| `.ai/agent-fleet.json` | the deterministic `agent-fleet` lifecycle (`setup`) — human-owned desired state (preset/features); intended to be committed | Every setup plan; created/updated when setup persists desired state or migrates legacy installs |
| `.ai/agent-fleet-state.json` | the deterministic `agent-fleet` lifecycle (`setup`, `doctor`, `uninstall`) | Every lifecycle plan and apply |
| `.ai/agent-fleet-setup.md` | humans — rendered from the state file, never parsed back | Rewritten on every setup apply |
| `.ai/agent-fleet-transaction.json` | the deterministic lifecycle (`setup`, `doctor --fix`) — crash-recovery journal for in-flight file transactions | Written during apply; recovered or discarded by setup/doctor; removed when the transaction commits or is cleaned up |
| `.ai/stt.json` *(optional)* | `pi-voice-stt` extension | Every pi session start, when the extension is installed |
| `.ai/system1.json` *(optional)* | System 1 shared runtime and doctor | When the experimental `system1` feature is explicitly selected |
| `.ai/proactive-review.json` *(optional)* | Hub proactive turn review consumer | At Hub session start; missing means off |

The `.ai/system1.json` file is human-owned, non-secret provider configuration.
Setup prints its required shape but does not create or overwrite it. Its
`apiKeyEnv` field names a caller-environment variable; it never contains the
credential itself. See [System 1 configuration](#system-1-configuration).

The `.ai/stt.json` file is present only when the optional `pi-voice-stt` voice-dictation
extension has been configured (by deterministic setup or by hand). Like the overrides file it holds
**no secrets** — it names the env vars (`apiKeyEnv`, plus the Azure endpoint var) whose values
live in a gitignored root `.env`. See [pi-voice-stt config](#ai-sttjson) below.

Keep them split: the overrides file is loaded into context constantly, so it
must stay minimal; the install record is read only by the CLI, so it can be
large.

## Unified Fleet runtime configuration

A Pi workspace has one public runtime entry point. Bare Fleet loads Fleet Core
plus Agent Hub in **operator** work mode, in the current terminal, with no native
specialists active:

```bash
just fleet
just fleet --project af
```

Work mode, native roster, and peer topology are separate controls:

```bash
# Direct tools plus an available native roster.
just fleet --work-mode operator --agents frontend --project af

# A roster implies orchestrator when work mode is not explicit.
just fleet --agents frontend --project af

# Herdr Hub-only and Hub-plus-peer topologies.
just fleet --herdr --project af
just fleet --agents frontend --peers frontend --project af
```

Startup precedence is deterministic: explicit `--work-mode` wins; otherwise an
explicit `--agents` roster implies `orchestrator`; otherwise work mode is
`operator`. An orchestrator startup must name a roster. `--herdr` affects only
placement, while `--peers <preset>` implies Herdr and starts the selected peer
preset. Neither topology option selects a native roster.

`--project <name>` selects one coms namespace for the Hub and every standing or
dynamically spawned peer. Dynamic peer tools deliberately expose no project
override, so an agent cannot cross that boundary. The default project is
`default`; use an explicit project when multiple fleets share a machine.

The configuration files have distinct ownership:

| File | Controls |
| --- | --- |
| `.pi/agents/teams.yaml` | Named **native rosters** of Pi personas available to `dispatch_agent`. Bare Fleet ignores YAML ordering and starts empty; select one with `--agents`, `/af-agents-team`, or add individuals with `/af-agents-add`. |
| `.pi/agents/peers.yaml` | Named **standing peer presets** and each peer's runner (`pi` or `claude-code`), persona, model, extensions, and optional declared `env_file`. Select a preset with `--peers`; dynamic `herdr_spawn_peer` uses the same declaration resolver. |
| `.pi/agents/dispatch-policy.yaml` | Routing used only when `dispatch_agent.backend` is `auto`: native/coms preference, fallback, grace period, and peer reply timeout. |
| `.ai/agent-fleet-overrides.md` (`## agent-hub`) | Project-specific Hub language, model overrides, rule/doc roots, budget ceilings, watchdog, and related execution policy. It does not choose startup work mode or topology. |

For deterministic routing, `backend: "native"` always starts the local Pi
specialist even if a same-name peer is visible. `backend: "coms"` requires a
visible same-name peer and refuses without native fallback. The default
`backend: "auto"` follows `dispatch-policy.yaml` and preserves its configured
fallback behavior.

Capability packs load automatically—do not run an activation command. Explicit task intent activates the matching ready surface; readiness alone never exposes coms or Herdr tools to the model. Ambiguous fleet/peer/workspace intent gets one confirmation before its first side effect, and active task packs persist until the explicit `set_task_tier(new_task: true)` reset.

Capability flags and runtime gates fail closed:

- `--no-coms` keeps operator direct tools and native dispatch available, but
  peer dispatch, `coms_send`/`coms_await`, and `/af-handoff` refuse actionably.
- `--herdr` and `--peers` require a running [Herdr](https://herdr.dev) server.
  Without Herdr, bare Fleet still works and dynamic pane tools stay inactive.
- `--browser` adds the browser extension surface and `--all-extensions` opts
  into the complete approved extension set. Missing optional dependencies do
  not grant tools merely because a flag was supplied.
- Hub-owned slash commands remain registered in both work modes. A missing coms
  runtime, Herdr connection, target peer, or native roster produces a
  capability refusal rather than a missing command.

During the migration release, `just fleet hub`, `just fleet team <preset>`,
`just fleet team <preset> --no-hub`, and `--solo` remain accepted and print a
canonical replacement. New automation should use `just fleet` with
`--agents`, `--peers`, `--herdr`, and `--no-coms`; compatibility does not imply
that the deprecated grammar will remain indefinitely.

### Resume and recovery

The Hub distinguishes the **pre-turn surface** (stable replacement prompt, volatile state capsule,
and active tool schemas) from **intra-turn pressure** (conversation and tool results accumulated in
the live model window). `/af-context` shows both. At 80% live usage the Hub warns and transiently makes
compaction support available; at 90% it blocks the next provider continuation and requests a
single automatic compaction after the current result is persisted. A prompt submitted during
startup/recovery is retained in memory and replayed once after success.

If automatic recovery fails, the prompt remains retained. Pi's built-in command is the bare-runtime
fallback:

```text
/compact Preserve the current goal, decisions, modified files, pending operations, blockers, and next step.
```

You can also switch to a larger-context model. Do not try to make room by editing the session file.
The JSONL shown by `/session` under `~/.pi/agent/sessions/` is Pi's authoritative append-only record;
resume with `/resume`, `pi -c`, or `pi --session <path|id>`. Never edit, truncate, reorder, or add
synthetic entries to recover from context pressure.

A resumed orchestrator session may instead be blocked because its persisted team name no longer
resolves against the current `.pi/agents/teams.yaml` and persona files. This is a fail-closed roster
recovery gate: orchestrator work mode and its direct-tool restrictions remain in force. Choose a valid
team with `/af-agents-team`, restart publicly with `just fleet --agents <name>`, or explicitly choose
operator work mode with `/af-work-mode operator` / `just fleet --work-mode operator`. Direct Pi launches
use `--agent-team <name>` or `--work-mode operator`. Explicit startup flags win over persisted state;
fix missing or renamed team/persona declarations before selecting them.

## System 1 configuration

System 1 is an experimental named feature and is excluded from automatic
Default/Full selection. Select it explicitly and persist that desired state when
needed:

```bash
npx @chankov/agent-fleet@latest setup \
  --preset default --features system1 --save-desired --yes
```

Then create the human-owned `.ai/system1.json` with exactly these version-1
fields and values:

```json
{
  "version": 1,
  "mode": "auto",
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "apiKeyEnv": "TYPESAFE_API_KEY"
}
```

`mode: "off"` disables the service even when a key exists. Selection plus
`mode: "auto"` still requires the valid configuration and a nonempty
`TYPESAFE_API_KEY` in the caller environment. Key presence alone never enables
System 1. The runtime does not execute `.env`: the managed `just` launcher can
load the root `.env`, while a direct Node invocation must receive an exported or
otherwise injected variable.

`agent-fleet doctor` reads the desired state and configuration as data. Its
System 1 result is advisory and read-only, including with `--fix`; it performs
no provider request and does not validate the key. A declaration in `.env` is
reported separately from a value present in doctor's current environment.

The installed demo is offline unless `--live` is supplied. Both forms require a
Node runtime supporting `--experimental-strip-types`:

```bash
# Readiness only; no provider call.
node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main \
  .pi/harnesses/lib/system1/demo.ts

# Explicit live request using only embedded synthetic Bulgarian/English data.
node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main \
  .pi/harnesses/lib/system1/demo.ts --live
```

The only phase-0 production provider/model is TypeSafe Jev `jev-1.13.0` at its
fixed official endpoint. No local model is installed and no fallback model is
selected. Outputs preserve available uncertainty but do not establish truth,
action authority, or calibration for a particular domain/language. The native specialist drift watchdog has a separate **consumer opt-in**:
`watchdog-system1: off|shadow|active` in `## agent-hub` (default `off`).
It also requires an armed watchdog, explicit feature selection, valid shared
configuration and a key. `off` makes no System 1 evaluation. `shadow` runs the
LLM judge immediately and System 1 in parallel; only the LLM can stop a child.
`active` is an **uncalibrated, explicitly opted-in experiment**: only the
advisory `scope` rule may skip LLM when Jev `jev-1.13.0` returns provider
`on_track` with confidence and on-track distribution ≥0.95 and all three
contradiction probabilities ≤0.05. Terminal `loop`, `failures`, and `toolcap`
always use LLM. `/af-watchdog` labels this `experimental: scope only; G2 not
validated`. This can miss a scope advisory; it is not G2 approval. Missing or
mismatched provider/config returns to LLM; default consumer mode remains off. Restart Hub to apply a
consumer mode/config snapshot; `/af-watchdog on|off|auto` changes Layer 1 arming,
not the System 1 consumer mode. For rollback set `watchdog-system1: off` for the
next session (cancel the current run if needed).

**System 1 outbound state** is limited to a redacted task, normalized relative
scope/paths, 40 structured tool events without commands, bodies, arguments or
outputs, rule facts, coverage and counters (32 KiB maximum). This does **not**
limit the existing parallel LLM judge prompt: it includes the original task,
scope and a recent trail with up to 120 characters of raw tool arguments per
call. Both paths can reveal data. For a future pilot, review the tasks, files
and likely tool arguments; never use client/production data or secrets. Manual
review cannot guarantee that an agent will not produce unexpected arguments.
The final native spawn env removes `TYPESAFE_API_KEY`; this does not protect
against file reads or other launchers. Trace (`<sessionDir>/artifacts/watchdog/events.jsonl`)
records only allowlisted metadata. `/af-watchdog` shows readiness/checks, the
strip under chat and `/af-agents` show owner badges and detail history;
`/af-hub-report` counts evaluations/LLM attempts separately; `/af-audit`
shows read-only decision status including `judge_unavailable`. Missing usage
is unknown, not zero. A failed judge gets one live, revalidated retry after 5 s
rather than the 90 s success cooldown. Offline report code and mock tests are
not a real shadow pilot. G1 requires manual/outbound review; G2 additionally
requires independent human labels identifying the snapshot **and LLM attempt**,
held-out session evaluation and an explicit maintainer-approved profile. Older
labels without an LLM attempt ID cannot qualify. No gate is inferred from doctor readiness.

## Proactive turn review (experimental)

This is a **separate per-repository opt-in**, not a new provider or an installer
feature flag. The Hub/native consumer uses the existing shared System 1 service
(`system1` feature, `.ai/system1.json`, caller-owned key) only when selected
excerpts are explicitly permitted and the service is ready. Its config is
human-owned `.ai/proactive-review.json`; setup/doctor do not create or activate
it. Missing config or valid `{"version":1,"mode":"off"}` causes **zero
proactive capture, inference, and feedback**. Invalid configuration fails closed.
Nothing here authorizes a live pilot, client repository, ringithub, provider
request, release, deployment or active configuration change.

Modes: `shadow` records bounded local evidence/findings without feedback;
`advisory` additionally offers bounded feedback at the next **natural** turn,
never starting a turn itself. With `remoteContext: "disabled"` (the default),
either enabled mode is **local-only**: source-bound deterministic checks may
run, but no semantic model review; no finding does not mean reviewed. With
`remoteContext: "selected-excerpts"`, permitted included source/assistant
excerpts may be transmitted to the already configured System 1 provider for
semantic assessment. This is not a blanket secrecy guarantee: source is
selected within approved scope and bounded/excluded, but automatic comprehensive
redaction of unknown secrets is not established. Review the *exact outbound
payload* and scope before any real opt-in. No auto-fix, kill, blocking,
acceptance authority, watchdog override, or autonomous continuation follows a
finding. Feedback is restricted to the same owner/attempt/task and current
source hashes and the session-bound rule revision, once per finding revision, at an already-occurring context
hook; changed evidence is refused.

**Schema illustration only — NOT executed, NOT authorization or a recommended
repository scope:** after separate human approval of the exact repository,
paths, outbound categories, budget and payload, a human may choose values in
this shape; do not copy these example paths into active configuration:

```json
{
  "version": 1,
  "mode": "shadow",
  "remoteContext": "selected-excerpts",
  "include": ["src/**", "docs/**"],
  "maxEvaluationsPerSession": 100
}
```

Only `version`, `mode`, `remoteContext`, `include`,
`maxEvaluationsPerSession`, `localBindings` are accepted. Version is `1`;
mode is `off|shadow|advisory`; remote context is
`disabled|selected-excerpts`. Enabled modes require a nonempty explicit
repository-relative `include` (≤32 distinct entries, ≤256 characters each;
no absolute/dot/traversal paths, hidden segments, backslashes, special
bracket/negation patterns or dependency/build/runtime directories). The
session evaluation budget is an integer 0–100, default 100 in enabled modes.
The optional `localBindings` (≤16) require reviewed source-bound Markdown
`rule` path/heading/positive occurrence/lowercase SHA-256 hash,
`applicability` paths and added/modified kinds, and explicit paths/legacy
exceptions; `new-file-placement` also needs an added-only prefix, while
`relative-markdown-links` checks link form/escape, **not target existence**.
These are not prose-rule compilation or a general Markdown/AST validator.
Off must not retain active includes, remote permission, bindings or explicit
nonzero budget: rollback uses the complete minimal off JSON above, then a
**new Hub session**. Cancel current work if immediate interruption is needed;
do not delete session evidence or user config as cleanup.

Rules come read-only from `rules:` roots in `## agent-hub` (legacy
`## agent-team`): index-first, literal Markdown links/references and bounded
recursive fallback. The catalog binds file/path, heading occurrence and hash
for the **session**; edits do not reload in-session, and a restart adopts them.
It cannot execute instructions in rules. Discovery has a 64-file/256 KiB
budget; selection at most 20 sections/32 KiB, with coverage gaps for missing,
unsafe, partial, unselected or unsupported sources. Only the explicit task
and explicitly supplied plan bind the review; absent plan is `task_only`, not
a search for the newest plan. Incomplete work, exceptions, parallel authorship
and same-turn rule edits can remain uncertain. No silence or skipped check is
proof of compliance. Hub and supported native specialists are covered;
research helpers, nested delegates, coms peers and Hermes are not.

Per turn: at most 20 source units, 256 KiB retained excerpts (64 KiB/file),
32 KiB evaluation state, 16 questions/batch, two calls/turn, one active
job/session, one pending/owner with backlog ≤8 and 5 s queue wait. Capture
phase has a 1 s deadline; evaluation job has a 2 s deadline. Feedback is
≤3 findings/1,500 characters; finding history/private snapshots are bounded
at 100, so readback/retention is **not** a complete session record. Captures
bind pre/post worktree bytes, hashes and offsets; private evidence can be
locally reopened with validated references, whereas trace/report summaries
contain metadata only. Exclude `.env`, credentials, `.git`, dependencies,
build/runtime/session/transcript trees, binaries and realpath escapes; never
assume redaction catches every secret. Review coverage can be `partial`, `not_checked`, `unsupported`, `stale`,
`unavailable` or `unknown` rather than a confirmed pass. Operator TUI/history retain a completed row briefly (10 s); metadata
readback persists within the bounded session record.

### Release readiness and evaluation limits

The opt-in runtime, native observer, local validators, advisory delivery, Fleet
history/evidence, reports and package installation are implemented and
independently reviewed. Offline integration uses repo-local Pi **0.84.2**;
Node 18 compatibility applies separately to the installed CLI/doctor, not the
Pi harness. Review history and evidence retain the dashboard's fixed-height
frame, including blank rows, rather than exposing dispatcher chat underneath.

A maintainer-authorized synthetic Jev smoke has verified real provider
communication and the evaluator path. It is **not** the planned 30-case
human-labelled semantic evaluation, nor evidence of general accuracy or recall.
That evaluation and final semantic acceptance remain outstanding; findings-only
label-key access also limits operational miss/true-negative evaluation.

A release installs the capability, **not its activation**. Setup does not create
`.ai/proactive-review.json`, and preserves an existing human-owned file. The
maintainer's active config and repo-specific rule catalog are not release
artifacts. Each target repository needs its own explicit scope, rules and
outbound-data consent. Configuration/rules are loaded at session start; start a
fresh Fleet session after changing them. When testing file placement, verify
that the file is really inside the configured repository include path, not a
session `artifacts/` directory with a similar relative suffix.

### Read-only reports and explicit human labels

`/af-hub-report` and `/af-audit` separate proactive and watchdog totals.
For measured comparison only, add `--labels /absolute/path/to/CURRENT_SESSION/artifacts/labels.json`
to **either** command. No default, file discovery, provider request or
automatic label inference occurs. The actual path must be an absolute regular
`.json` file below the *current* session's `artifacts/`, without symlink escape;
maximum 64 KiB and 320 labels. Only retained findings currently expose operator-readable label keys. In Fleet
Dashboard (**Alt+A**), open review history with **`p`**, select a finding with
**`n`**, then press **`e`** for its local captured evidence; alternatively open
the specialist detail, select a finding with **`n`**, and press **`e`**. Scroll
with ↑/↓ (or j/k), PgUp/PgDn, Home/End; Esc returns to the previous review-history or detail view. The evidence
view displays a JSON record with the exact `snapshotId`, slash-bearing catalog
`ruleId` (`path#heading@occurrence:hash`), session-bound `ruleHash`, and
`subject` for that finding. At narrow widths the JSON is wrapped into visual
chunks: remove one indentation column from each chunk and concatenate the
chunks to reconstruct the record. Unavailable evidence shows no template;
do not guess a key. Copy the reconstructed record into an explicit local
current-session artifacts `.json` array, leaving `expected` as `unknown` until
a human judges that finding (`violation` or `clean`). Never use raw
source/prompt payloads as label keys. This illustrative shape is not a
substitute for the evidence-view values:

```json
[
  {
    "snapshotId": "<actual lowercase 64-hex snapshot ID>",
    "ruleId": "<actual evidence-view catalog rule ID, including path/slashes>",
    "ruleHash": "<actual bound lowercase 64-hex rule hash>",
    "subject": "src/example.ts",
    "expected": "unknown"
  }
]
```

Each object has **exactly** these five keys; `expected` is
`violation|clean|unknown`. Match snapshot, rule ID, session-bound rule hash and subject to retained
finding evidence; a valid unmatched label is `unchecked`, not a false
pass/miss. Report comparison can join checked-clear verdicts, but the operator
UI exposes keys only for retained findings, not checked-clear units. Human
miss/true-negative labels cannot currently be authored from this UI; absent
human labels remain `unknown`. This is a partial finding-backed workflow, not
fully operational misses or recall evaluation. Missing/invalid labels yield `unavailable` with null
measurement counts; empty valid array is not a precision/recall score.
Counts distinguish reviewed/partial/coverage-unknown/skipped, uncovered rules,
deterministic findings versus System 1 suspicions, unknown usage and unknown
native delivery (no receipt). Trace-only readback does not reconstruct missing
coverage or invent zeroes. Any precision or miss count describes only *labelled checked* evidence, not
unlabelled clear units or universal correctness.

### Offline installed-package runbook (not executed by this documentation change)

Use a fresh **temporary** directory/workspace, with Node supporting native
TypeScript for the observer, repo-local Pi 0.84.2, and existing dependencies;
Node 18 is checked separately for the extracted CLI. These are test-backed
instructions, **not** commands run by this documentation patch. From this
repository's root, the safest reproducible run is:

```sh
node --test .pi/agent-fleet/scripts/docs-links.test.mjs
# Supply an actual installed Node 18 executable; the test fails if unavailable.
AF_NODE18=/absolute/path/to/node18 node --test bin/test/proactive-installed.test.js
node --test --test-name-pattern='isolated tarball supports' bin/test/package-surfaces.test.js
```

The installed test packs with `npm pack --json --pack-destination <temp>`,
extracts with `tar -xzf <tarball> --strip-components=1 -C <temp>/package`,
and runs `node <temp>/package/bin/cli.js setup --workspace <temp>/installed
--preset default --features none --yes` under a scrubbed offline environment.
It checks the installed 12-file runtime closure and an offline fake-provider Pi
observer/capture, no auto `.ai/proactive-review.json` or proactive desired-state
key, preservation of a **test-only HUMAN fixture** across repeat setup and
`doctor`/`doctor --fix`, and extracted-CLI version/help/readonly doctor under
Node 18. Doctor may return 0 or findings exit 2. The smoke reuses existing
repository dependencies, not a fresh dependency install; its network guard is
limited and does not prove every step physically network-isolated. Do not
create the illustrative active config above in a real workspace while testing.
The operator must run the link test and installed test on the final changed
state; this document alone is not verification.

### Separate live pilot and acceptance

C5 operator visibility was human accepted, and the final post-fix source/docs
review accepted the C6 offline/package work. The later review-history overlay
fix is covered by fixed-frame and real Pi compositor regression tests; its
human visual retest is separate. Implemented/offline/installed evidence is not
live semantic accuracy. Explicit advisory activation in the maintainer's
repository and a synthetic Jev transport/evaluator smoke have occurred; neither
completes the planned human-labelled pilot or C7 semantic acceptance. For a new
repository, first review synthetic/offline evidence, then require **explicit
repo-specific shadow consent**, including exact include/exclusion paths,
reviewed bindings, session budget, outbound categories and representative
exact payload review; separate explicit consent is required for advisory.
There is no implied ringithub/customer repo authorization. A subsequent pilot
requires ≥30 **human-labelled** code/text assessments including ≥10 known
violations/deviations, BG/EN, legacy/new code, interim work, exceptions,
text-only and no-plan cases; manually review selector omissions and uncertain
cases. Measure finding-backed labelled precision and false alarms alongside coverage,
capture overhead, model p50/p95 latency, queue drops and known/unknown usage.
Miss/true-negative human-label keys for checked-clear units are not exposed;
report miss joins from synthetic/offline tests do not establish operational
miss/recall measurement. Record that gap explicitly in any pilot assessment
rather than treating unknown labels as negatives. Synthetic/offline success is not semantic or live
proof; no automatic mode promotion or invented accuracy threshold. C7 asks
the maintainer to accept limitations/evidence and explicitly choose each
repository's off/shadow/advisory state. No release or deployment follows from
these docs or C6.

## The overrides file — `.ai/agent-fleet-overrides.md`

Some skills and pi harnesses need facts specific to each project — where specs
and plans are saved, how to start a dev server, whether the agent may create
branches, or which user-facing language a dispatcher should use. Each reader
ships a sensible **default**; a project that needs something different declares
it here, and the reader picks it up.

- **Location:** `.ai/agent-fleet-overrides.md` at the project root.
- **Format:** Markdown. One `## <section-name>` section per skill or harness reader, with terse
  `key: value` lines. Block values use the `key: |` multi-line form. No prose
  and no install detail — readers parse it by key and load it on every run/session start.
- **Commit it.** Shared project configuration belongs in version control. Make
  sure no `.gitignore` rule (for example a broad `.env*` pattern) excludes it.
- **No secrets.** For anything sensitive (test-account credentials), reference
  the **name** of an environment variable; the real value lives in a gitignored
  `.env`.
- If the file is absent, or a reader has no section in it, that reader uses its
  built-in default.
- **Settings writer:** ordinary `agent-fleet setup` leaves non-empty overrides byte-identical. To add rule/doc roots explicitly, preview with `agent-fleet configure --rules .ai/rules --docs docs --dry-run --workspace <project>`; review `before`, `after`, and `expectedHash`, then apply with the same roots, `--expect-hash <expectedHash> --yes`. Omit a key to leave it unchanged. The CLI appends/deduplicates roots, keeps other sections/settings and the legacy `agent-team` section, and refuses duplicate/conflicting sections or keys for manual resolution. A changed setting takes effect in a new session; missing roots remain advisory. The interactive path is `/af-setup-rules` (the `repository-ai-setup` skill: discovery → proposal → grilling → diff → apply → verify); it hands accepted roots to this same CLI and never edits the file directly.
- **Validation.** Because an unknown section or key silently falls back to the
  default, typos are invisible at runtime. `agent-fleet doctor` (and the
  runtime's Agent Fleet doctor command) validates the file — unknown sections,
  unknown keys in known sections, invalid values for the mechanically parsed
  `agent-hub` keys, missing `rules:` folders, missing `append-prompt:` files,
  unknown `poll-panel:` names, and unset `## env` vars — as
  **advisory, warn-only findings**; it never edits the file.

### `spec-driven-development`

| Key | Default | Meaning |
|-----|---------|---------|
| `spec-dir` | `docs/prds/{area}` | Directory specs are written to |
| `naming` | `PRD{n}-{topic}` | File name pattern; `{n}` = next free PRD number, `{topic}` = kebab-case slug |

Default output: `docs/prds/{area}/PRD{n}-{topic}.md`.

### `planning-and-task-breakdown`

| Key | Default | Meaning |
|-----|---------|---------|
| `plan-dir` | `docs/plans/{area}` | Directory plans are written to |
| `naming` | `PLAN-{prd-name}-{phase}` | File name pattern; `{phase}` suffix only when a plan spans multiple files |
| `todo` | `embedded` | `embedded` keeps the task list inside the plan; `separate` writes a standalone `todo.md` |

Default output: `docs/plans/{area}/PLAN-{prd-name}-{phase}.md`, task list embedded.

### `browser-testing-with-devtools`

This skill has **no default** — the section is required for browser testing,
because dev-server commands and login flows cannot be guessed.

| Key | Meaning |
|-----|---------|
| `dev-server` | Command to start the local dev server |
| `ready-check` | How to confirm the server is up |
| `base-url` | Root URL for navigation |
| `auth-flow` | Steps to log in (multi-line `|` block) |
| `roles` | Test account per privilege level, referenced by env-var name |
| `notes` | Anything else the agent should know (certs, seed data, ...) |

### `git-workflow-and-versioning`

| Key | Default | Meaning |
|-----|---------|---------|
| `branching` | `never` | `never` = agent works in the current branch and never creates or switches branches; `allow` = agent may create feature branches |

### `agent-hub`

Read by the `.pi/harnesses/agent-hub/` pi harness on every session start. The canonical
section name is `## agent-hub`; the harness also accepts the legacy `## agent-team` name
(from before the standalone `agent-team` harness was retired), so existing project
override files keep working unchanged. When both sections are present their keys merge,
with later lines winning.

The `rules:` and `docs:` keys are also read outside the harness: the `compound-learning`
skill (and the `/af-compound` agent-hub command built on it) resolves them as the
targets an end-of-session compound pass writes lessons to.

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `English` | User-facing language the dispatcher uses for every `ask_user` question, every `context` field, and every summary. Specialist task strings always stay in English regardless. |
| `persona-gate` | — | **Removed.** Ignored with a doctor warning; dispatcher flavor is no longer selectable. Use `/af-work-mode` for operator vs orchestrator. Delete the key. |
| `model.<persona>` | persona frontmatter `model:` | Replaces the named persona's default model for this project (a full pi model spec). If the override reports a model/provider error or aborted request before producing text or starting a tool (including a local-model memory-limit failure), agent-hub restores the child session and retries once with the original frontmatter model; it does not fallback after work starts, cancellation, timeout, drift stop, or process-spawn failure. |
| `models.<persona>` | persona frontmatter `models:` | Replaces the named persona's model-candidate list for `/af-agent-model` and `/af-models` profiles (comma-separated pi model specs). |
| `thinking.<persona>` | persona frontmatter `thinking:` | Replaces the named persona's pi `--thinking` reasoning level for this project: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Switchable at runtime with `/af-agent-model-thinking <persona>`. An invalid value is ignored with a session-start warning. |
| `subagents.<persona>.<role>` | persona frontmatter `subagents:` | Replaces or adds one delegate sub-role for this project: `<model>[, tools=<caps>][, thinking=<off\|minimal\|low\|medium\|high\|xhigh>]`. Other declared roles keep their frontmatter values. Existing roles retain their original frontmatter model as the same one-shot, pre-work-only runtime fallback; model-only overrides retain the declared tool cap. An invalid `thinking=` value is ignored with a session-start warning and the role stays at `off` unless frontmatter already set a valid level. |
| `delegate-depth.<persona>` | persona frontmatter `delegate_depth:` (default/max 1) | Replaces the persona's delegation depth budget: `0` makes its delegate tool refuse (delegation off for this project), `1` lets it spawn terminal children. Values above 1 are clamped to 1; children at remaining depth 0 do not receive delegate tooling. |
| `rules` | none | Comma-separated repo-relative folders holding the project's own rule files (HOW — implementation patterns the work must comply with). Resolution is **index-first**: when a folder has a top-level `README.md`/`index.md`, personas read it first and follow its loading manifest (session bundles, conditional-load lists) instead of bulk-reading the tree; a folder without an index is searched **recursively** through all subfolders. The harness tells every dispatched specialist where the rules live and how to resolve them; the planner and code-reviewer personas read the relevant rules, validate their subject against them, and pass them on (cited in plan acceptance criteria / handed to delegate sub-reviewers). Missing folders produce a session-start warning. |
| `docs` | none | Comma-separated repo-relative documentation **entry points** (WHAT/WHY — architecture, standards, decisions): canonical files (e.g. `Docs/AGENTS.md`) or doc folders (personas start from a folder's `README.md`/index). Unlike `rules`, docs orient rather than bind: every dispatched specialist and research helper is told to read the entry points relevant to its task and follow their links instead of bulk-reading doc trees; the code-reviewer flags changes that alter documented behavior without a doc update; the documenter treats the entry points and the trees they link as the docs it maintains. Missing paths produce a session-start warning. |
| `research-keep` | — | **Removed.** Ignored with a session-start warning; live research helpers disappear from the Fleet Dashboard (`Alt+A`) on every terminal outcome. Session, transcript, and findings files plus `/af-agents-history` records remain. Delete the key. |
| `recon-search-timeout-s` | `120` | Parent-side deadline, in seconds, for each `read`, `grep`, `find`, or `ls` call made by a native research helper or nested delegate child. Accepts an integer `1`–`3600` or `off`; invalid input warns and falls back to `120`. This is **not** an agent/turn deadline: non-tool work can run indefinitely. On timeout the hub returns `tool_timeout` with call metadata, sends SIGTERM to its owned process group, escalates to SIGKILL after a finite grace period, and settles even if the child never closes or a descendant holds a pipe. If that bounded cleanup cannot confirm child/process-group death, the metadata reports `terminationConfirmed: false`; this prevents a parent hang but may indicate an uninterruptible OS-level process needing operator attention. |
| `mode` | — | **Removed.** Ignored with a warning; budgets follow task tier. Delete the key. |
| `max-dispatches-per-turn` | tier default (1/2/8/12) | Ceiling on `dispatch_agent` calls per user turn (`min` with the task-tier envelope). Positive integer or `off` (stays at the tier). |
| `max-research-per-turn` | tier default (1/2/4/6) | Ceiling on dispatcher-initiated `spawn_research` calls per user turn. The automatic `NEEDS_RESEARCH:` pipe is exempt from the turn budget but still counts against the task research envelope. Positive integer or `off` (stays at the tier). |
| `turn-wall-time-s` | tier default (900/900/3600/5400) | Active-time ceiling, in seconds, per user turn; time blocked in `ask_user` is excluded. Once exceeded, further dispatch/research calls refuse until the one-click continuation is accepted or a new user turn begins. Positive integer or `off` (stays at the tier). |
| `agent-turn-timeout-s` | tier default (600/600/1800/1800) | Whole-run deadline, in seconds, for each spawned specialist, research helper, and nested delegate child (unlike `recon-search-timeout-s`, this bounds the entire run). On expiry the run terminates as `turn_timeout` (exit 124) with partial output preserved. Positive integer or `off` (stays at the tier). |
| `session-recycle-runs` | tier default (3/3/5/5) | Recycle a specialist's accumulated session (fresh spawn instead of `-c` resume) after this many resumed runs. Context is also always recycled at ≥60% measured context (input + cacheRead + cacheWrite). Positive integer or `off` (stays at the tier recycle count; context threshold still applies). |
| `watchdog` | `auto` | Drift watchdog default for dispatched specialists: `auto`/`on` arm the in-flight rules (out-of-scope writes, tool-call loops, repeated failures, tool-call cap) with LLM-judge escalation; `off` disarms. Orchestrator work mode auto-arms when the setting is `auto`/`on` and ignores a dispatch `watchdog: false`. Overridable live per hub (`/af-watchdog on\|off\|auto`) and per agent (`/af-watchdog <agent> on\|off\|clear`). A DRIFTING/STUCK verdict terminates the run as `drift_stop` (exit 125) with partial output preserved. |
| `watchdog-system1` | `off` | Native specialist consumer only: `off`, `shadow`, or explicitly opted-in experimental `active` for advisory `scope` only (0.95/0.05; not G2-validated). Requires the separate selected feature and shared config; no automatic outbound request from setup/doctor. |
| `watchdog-judge-model` | researcher persona's model | pi model spec for the one-shot drift judge (e.g. `openai-codex/gpt-5.3-codex-spark`). Falls back to the researcher persona's resolved model, then the dispatcher's. |
| `poll-panel` | none | Default panel name for `/af-poll` when `--panel` is omitted. Must match a panel in `.pi/agents/voices.yaml` when that file exists. Missing `--panel` and missing this key is a refusal. |
| `append-prompt` | none | Comma-separated repo-relative files appended to the system prompt of every dispatched persona. Listed files must exist. Enable the communication contract with `append-prompt: references/communication-contract.md`. |

Example — switch the dispatcher to Bulgarian, pin the builder to sonnet, raise the
code-reviewer's thinking level, move the code-reviewer's docs sub-reviewer to a
different model, and point the team at the project's rule folders and doc entry
points:

```markdown
## agent-hub
language: Bulgarian
model.builder: github-copilot/claude-sonnet-4.6
models.builder: github-copilot/claude-sonnet-4.6, github-copilot/claude-haiku-4.5
thinking.code-reviewer: xhigh
subagents.code-reviewer.docs: github-copilot/claude-sonnet-4.6, tools=read,grep, thinking=medium
delegate-depth.code-reviewer: 1
recon-search-timeout-s: 120 # or off to disable the per-tool watchdog
poll-panel: default
append-prompt: references/communication-contract.md
rules: docs/rules, .ai/rules
docs: Docs/AGENTS.md, Docs/architecture/ARCHITECTURE_OVERVIEW.md
```

### `env` (optional, read by the doctor)

The overrides file references environment variables by **name** — test-account
credentials for `browser-testing-with-devtools`, the `pi-voice-stt` API key —
while the values live in a gitignored root `.env`. The optional `## env`
section declares which names the project's readers expect, so a fresh clone
can find out what's missing *before* a skill fails mid-run:

| Key | Meaning |
|-----|---------|
| `required` | Comma-separated env-var **names** (never values) the project's sections reference |

```markdown
## env
required: APP_TEST_ADMIN_USER, APP_TEST_ADMIN_PASS, AZURE_SPEECH_KEY
```

No skill or harness loads this section. Its only reader is `agent-fleet doctor`
(and the runtime's Agent Fleet doctor command), which warns when a declared name is neither set in
the environment nor declared in the workspace root `.env`.

### Per-peer env files (`env_file:` in peers.yaml)

Fleet peers spawned through `--peers`, `just fleet peer`, or the Hub's
constrained dynamic peer tool can carry their own environment: an `env_file:`
entry in `.pi/agents/peers.yaml` names a
**repo-relative** KEY=VALUE file (same format as `.env`, no shell evaluation)
that herdr injects into the peer's pane before the command runs — no `source`,
no leaking into sibling panes. The file must exist at spawn (team-up refuses
otherwise, never mid-run), and its **values never appear in `--dry-run`
output** — only the path. Keep these files gitignored exactly like the root
`.env` this section describes.

## The install record — `.ai/agent-fleet-state.json` and `.ai/agent-fleet-setup.md`

Two files, one source of truth. `.ai/agent-fleet-state.json` is what the
installer writes and the only thing it reads back: agent, method, package
version, source root, and one entry per installed item with a per-file sha256
(or, in symlink mode, the resolved link target). `.ai/agent-fleet-setup.md` is
**rendered from it** on every apply and never parsed back, so the two cannot
disagree — it exists for humans and for older readers that still look for
`version:` and `agent:`.

Ownership is the point of the state file. An entry means "agent-fleet installed
this"; anything not listed is never removed or overwritten. That lookup is what
replaced the prose ownership rule the setup skill used to carry.

| State-file field | Meaning |
|---|---|
| `agent`, `method`, `sourceRoot` | How and from where this workspace was installed |
| `packageVersion` | The version that performed the last apply — provenance for reconciliation and legacy three-way compatibility |
| `items` | One entry per installed artifact: strategy, method, files with hashes, JSON key paths |
| `externalPackages` | Packages the user was told to install; recorded, never installed for them |
| `events` | Last few applies (verb, version, action count, conflicts) |

**No secrets, ever.** Only env-var *names* may appear — for example in the
`pi-voice-stt` record. A test asserts nothing value-shaped is persisted.

### The recorded version and the three-way merge

The recorded `packageVersion` gives every comparison a baseline. For each
recorded artifact, the engine compares *source@recorded* from the package's
`.versions/<x.y.z>/` snapshot tree, the installed copy on disk, and
*source@current*. Deterministic `setup` is the public reconciliation command.

| Outcome | What `setup` does |
|---|---|
| Neither moved | Kept |
| Only the source moved | Clean refresh |
| Only your copy moved | **Refreshed — your edit is overwritten.** Reported in the plan as *"locally modified — selecting it overwrites your edits"*, so `--dry-run` shows it before it happens |
| Both moved, to different content | **Conflict**: the run exits `3` before writing anything. Resolve with `--on-conflict theirs` or `--on-conflict ours` |
| Retired upstream | Kept by `setup`; the deprecated `upgrade` proposes removal by name, subject to the ownership rule |

Reconciling toward the package is the point of `setup`: the workspace is meant
to match the version it records. That is why editing a shipped artifact in place
is not a supported customization route — use `.ai/agent-fleet-overrides.md`, add
artifacts under names Agent Fleet does not ship, or leave the item out of the
selection (`setup` never removes what it does not select, so an unselected item
stays installed and frozen). The deprecated `upgrade` verb preserves local edits
instead of overwriting them; if you have relied on that, it is the behavioural
difference to plan for.

If the snapshot is missing (an unpublished local build, or a version older than
`.versions/` retention), the comparison degrades to two-way, the installed copy
is treated as canonical, and the read-only auxiliary `verify` command reports it
as an advisory finding rather than pretending a diff exists.

### Pre-engine workspaces

A workspace with only `.ai/agent-fleet-setup.md` and no state file predates the
installer engine. `setup --migrate --dry-run` previews what it can infer from
that markdown (`agent:`, `version:`) without adopting unrecorded paths. To
mutate a legacy workspace, use `setup --migrate` with an explicit preset,
features, and `--yes`. A workspace with no `version:` at all has no recorded
baseline, so no three-way merge is attempted.

Commit these files if the team should share install state — keep paths relative
so they stay portable. A self-referencing checkout (agent-fleet itself) may
instead `.gitignore` them, since their recorded paths are local to one machine.

## Coms-backed team members

A team member the `agent-hub` harness dispatches (`.pi/agents/teams.yaml`) can be
served by a live coms peer of the same name instead of a freshly spawned native
subagent. With the default `backend: "auto"`,
`.pi/agents/dispatch-policy.yaml` decides that per member at dispatch time;
explicit `native` bypasses substitution, while explicit `coms` requires the
peer and never falls back. `.pi/agents/peers.yaml` decides *how* each peer runs.
A peer with `runner: claude-code` is an interactive Claude Code pane plus its
bridge — the one way Claude Code takes part in a fleet. See
[claude-code-coms-bridge.md](claude-code-coms-bridge.md).

Installing `skill:peer-coms` pulls `hook:coms-stop-hook` in as a companion, which
is what gives a bridged pane exact turn text instead of scraped output.
The hook installs to `.pi/agent-fleet/hooks/coms-stop-hook.mjs` with the rest
of the fleet runtime. Registering it in `.claude/settings.json` stays the
user's step — the installer writes files, and another tool's settings file is
not its to merge. `setup` prints this snippet when the hook is applied:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
    "command": "node $CLAUDE_PROJECT_DIR/.pi/agent-fleet/hooks/coms-stop-hook.mjs" }] }] } }
```

## Templates

### `.ai/agent-fleet-overrides.md`

Copy this in and delete the sections you don't need — anything absent falls
back to that reader's default.

```markdown
# Agent Fleet — Project Overrides
#
# Each section is applied ON TOP of the skill's built-in defaults.
# Keys not listed keep the default. Absent file/section → pure defaults.

## spec-driven-development
spec-dir: docs/prds/{area}
naming:   PRD{n}-{topic}

## planning-and-task-breakdown
plan-dir: docs/plans/{area}
naming:   PLAN-{prd-name}-{phase}
todo:     embedded

## browser-testing-with-devtools
dev-server:  <command to start the local dev server>
ready-check: <url or check that confirms the server is up>
base-url:    <root url>
auth-flow: |
  1. Navigate to <login url>
  2. Submit credentials for the role needed by the screen under test
roles:
  admin:  env APP_TEST_ADMIN_USER / APP_TEST_ADMIN_PASS
  player: env APP_TEST_PLAYER_USER / APP_TEST_PLAYER_PASS
notes: |
  <anything else: self-signed certs, required seed data, ...>

## git-workflow-and-versioning
branching: never

# Optional for pi agent-hub; omit this section to keep default English.
# (`## agent-team` is still accepted as a legacy alias for this section.)
## agent-hub
language: <language name>
rules: <repo-relative rule folder>[, <another folder>]
docs: <repo-relative doc entry point>[, <another file or folder>]

# Optional; names (never values) of env vars the sections above reference.
# Only `agent-fleet doctor` reads this — it warns when one is unset.
## env
required: <ENV_VAR_NAME>[, <ANOTHER_NAME>]
```

### `.ai/agent-fleet-setup.md`

Rendered from `.ai/agent-fleet-state.json` by every apply, for humans to read.
Edit the workspace, not this file — the next apply overwrites it.

```markdown
# Agent Fleet — Workspace Setup
#
# Generated from .ai/agent-fleet-state.json by `agent-fleet setup`.
# Edit the workspace, not this file: it is rewritten on every apply.

## workspace-summary
agent:   pi
method:  copy
version: 1.4.2
source:  /home/you/.npm/_npx/<hash>/node_modules/@chankov/agent-fleet

## install-status
skills:     [spec-driven-development, test-driven-development, code-review-and-quality]
commands:   [spec, plan, build]
personas:   [code-reviewer]
extensions: []
harnesses:  []
companions: [skills-internal-grilling]
external:   []
updated:    2026-05-22

## verification
- 21 item(s) recorded; run `agent-fleet doctor` for diagnostics.
- No secrets are stored in this file or in .ai/agent-fleet-state.json.
```

### `.ai/stt.json`

Optional. Present only when the `pi-voice-stt` extension is installed and configured. Read by
the extension on every pi session start, ahead of the global `~/.pi/agent/stt.json`. The
canonical format has a nested `provider` object. Runtime `provider.type` values are `openai`,
`openai-compatible`, `azure` (Azure Speech), and `azure-openai` (Azure OpenAI Whisper):

```json
{
  "language": "bg-BG",
  "provider": {
    "type": "azure",
    "apiKeyEnv": "AZURE_SPEECH_KEY",
    "locales": ["bg-BG", "en-US"]
  }
}
```

The setup CLI accepts the aliases `openai`, `groq`, `azure`, and `azure-openai`. These are
installer selections, not interchangeable runtime types: in particular, `groq` is not a
`provider.type`, and `azure` means Azure Speech rather than Azure OpenAI. Setup can generate
the OpenAI configuration from runtime defaults. For Groq, create a complete nested
`.ai/stt.json` with runtime type `openai-compatible` and the actual Groq endpoint/model, then
run setup without `--stt-provider groq`; the alias does not identify the prepared runtime type.
Other OpenAI-compatible services are not Groq and use their own endpoint/model. For Azure
Speech or Azure OpenAI in a workspace without STT settings, create complete nested JSON with
the provider-specific endpoint/deployment settings before setup. Setup does not guess them.

Existing valid nested files are preserved. Supported legacy flat files are also preserved and
produce a warning that runtime compatibility is not guaranteed; setup does not migrate them
automatically. Provider migration or replacement requires a separate explicit action.

The JSON stores only environment-variable names, never credential values. Put values in the
gitignored `.env` at the workspace root, which the managed justfile loads:

```sh
export AZURE_SPEECH_ENDPOINT=https://<resource>.cognitiveservices.azure.com
export AZURE_SPEECH_KEY=<your-resource-key>
```

Setup preserves existing `.env` declarations and values, including `export NAME=...` syntax,
and appends only missing empty placeholders. A direct `provider.endpoint` needs no endpoint
environment variable. Setup validates JSON structure and environment-variable names, but it
does not validate credentials or contact the provider. Full schema and provider examples:
[.pi/extensions/pi-voice-stt/README.md](../.pi/extensions/pi-voice-stt/README.md).

### Complete model profiles

`/af-models <name>` reads `.pi/agents/model-profiles.yaml`. Flat persona-to-model
maps remain supported and keep their declared-candidate validation. A `version: 2`
profile declares the whole execution model set independently of
`.ai/agent-fleet-overrides.md`:

```yaml
local-full:
  version: 2
  defaults:
    model: &qwen36 omlx/Qwen3.6-35B-A3B-4bit
    thinking: off
  allowed-models:
    - *qwen36
  fallback: none
  routing: native
  dispatcher: *qwen36
  agents:
    # Every shipped persona uses *qwen36 (see .pi/agents/model-profiles.yaml).
  subagents:
    # Every declared child role uses *qwen36.
  services:
    watchdog: *qwen36
    return-extractor: *qwen36
  panel:
    - { name: qwen-a, model: *qwen36 }
    - { name: qwen-b, model: *qwen36 }
    - { name: qwen-integrator, model: *qwen36, integrator: true }
```

- `defaults` supplies **every persona and every declared child**, including future
  personas, research helpers and team changes. `agents` and `subagents` contain
  exceptions. To preserve a persona's existing selection, omit it from `agents`;
  for example, `local-workers` leaves `orchestrator` out. Each selection accepts a
  model string or `{model, thinking}`.
  Unspecified thinking inherits defaults, then `off`. Tool caps and delegation
  depth remain unchanged. Unknown persona/child names are rejected.
- `dispatcher` changes the current Pi session's model and thinking. When omitted,
  the live dispatcher keeps its current selection and may use any Pi model, even
  outside `allowed-models`; that list still applies to workers and peers. An
  `orchestrator` persona entry alone is not the live dispatcher.
- `services` sets the watchdog and structured-return extractor independently;
  unspecified services use defaults. `panel` supplies 2–5 poll/debate voices and
  an optional single integrator. `/af-poll` and `/af-debate` select the active
  profile's panel automatically. Explicit other panel names are refused while
  the complete profile is active. Without `panel`, two default-model voices are used.
- `routing: native` (default) keeps Hub-owned work on native Pi subprocesses.
  Without `allowed-models` it still refuses explicit coms dispatch, handoff,
  `coms_send` and peer spawning. With `allowed-models`, those peer actions are
  allowed only when the peer's advertised or planned model is on the list
  (exact `provider/model`, or a unique provider-less suffix match); a foreign,
  missing, or `unknown` model is refused, and `claude-code` peers are refused
  because their models cannot be allowlisted. Existing peer processes are not
  reconfigured or stopped. `routing: configured` opts into the existing dispatch
  policy and cannot be combined with `allowed-models`, since a peer's nested
  children cannot be verified by this hub.
- `fallback: none` (default) disables automatic original-model fallback, including
  nested children and workflows. `declared` retains it. Optional `allowed-models`
  is an exact provider/model allowlist checked before actual child spawns and
  fallback attempts. Worker model pickers and session substitutions respect it;
  the live dispatcher is checked only when `dispatcher` is explicit.
  This governs Fleet model execution; it is not an OS/network sandbox for arbitrary
  shell commands or unrelated applications.

Activation validates the complete profile and Pi availability of its referenced
models before changing settings. Missing models leave the previous configuration
in place. Busy dispatchers, agents and poll/debate runs refuse switching: wait for
completion first. On leaving a complete profile, the previous dispatcher, thinking
and manual model/sub-role/substitution settings are restored before applying the
next profile. A fresh Pi session clears the active profile; select it again there.

The profile is passed through the owned process tree. Workflow commands started
from that session inherit its persona models, thinking, panel and fallback policy.
Separately started fleet sessions/standing peers retain their own configuration.
The bundled `local-full` profile explicitly covers all shipped child roles and needs
no project model overrides. Every role, service and panel entry uses the single
`omlx/Qwen3.6-35B-A3B-4bit` model. The `local-workers` profile uses that same local
model for agents, subagents, services and panel voices, while leaving `orchestrator`
to inherit its current selection; its peer allowlist refuses non-local coms models.
The model must be registered in Pi and served locally by oMLX. Selecting a profile
does not download or register models.
