# System 1 file discovery (D9)

D9 is an opt-in **automatic file ranker**, not a shortlist or an execution gate.
This checkout implements the runtime; published `@latest` is not evidence that
it contains D9. Default and Full installation leave System 1 off. Selection,
provider availability, independent export consent and consumer activation are
separate. Configuration is the human-owned [unified v2 document](system1-config.md).

## Configuration and consent

Keep the existing root provider/model/key-env settings and all other consumer
sections. After human consent, add this section under `consumers`:

```json
{
  "fileDiscovery": {
    "mode": "active",
    "remoteContextApproved": true,
    "include": [".pi/harnesses", "bin", "docs"]
  }
}
```

These roots are the separately approved roots for the Agent Fleet checkout,
**not defaults or consent for another repository**. In another repository the
human must explicitly choose its include roots. D10 `agenticAsk` consent never
activates D9. Missing/off D9 means no automatic capture, source export or
inference. Root `mode: off` disables inference; root `auto`, selected `system1`,
a valid consumer and caller-supplied `TYPESAFE_API_KEY` are needed for live use.
Never put key values in JSON, prompts or transcripts. Start a **new Hub session**
after configuration changes: the snapshot is immutable for the current session.

Defaults/maxima: concurrency 8, queued jobs 32, candidates 1024, evaluations/job
256, logical calls/session 10000, file bytes 65536, request bytes 131072,
source bytes/job 16777216, discovery 1000 ms, job 20000 ms, page bytes 32768,
cache entries 2048. Positive values can reduce these bounds, not raise them.
The discovery deadline includes Pi worker startup; slow hosts may get partial
or unavailable discovery. Runtime never installs a missing discovery executable.
Candidate limits bound matched candidates, **not visited filesystem entries**.

## Automatic surfaces and explicit A/B/C

With a known task and at least two unambiguous files, production `tool_result`
hooks rank before delivery to the next model step in both Hub work modes and
all task tiers:

- Parent `filesystem` inventory, typed `find`, `ls`, and parseable `grep`.
- Native research and specialist workers: initial full ranked context after
  launch gates, then current discoveries through their production child extension.
- Allowed nested delegates: separately registered descendant task/query and
  physical-attempt lease; never a copied parent capability.

The parent-only `ask_system1_files` uses the same engine:

```json
{"paths":["docs/a.ts","docs/b.ts"]}
```

```json
{"directories":["docs"],"patterns":["*.ts"],"recursive":false}
```

```json
{"directories":["docs"],"patterns":["**/*.ts"],"recursive":true}
```

A is explicit paths; B expands a directory/pattern; C recursively discovers and
orders all files without a mandatory second picker. Shallow discovery uses
immediate entries only; slash-containing shallow patterns refuse as
`invalid_pattern`, rather than silently claiming a complete empty result.
Up to 14 custom typed questions augment the two standard relevance/role
questions; `d9_relevance` and `d9_role` are reserved IDs.

No scope/read_scope means current same-task candidates, otherwise bounded
approved include roots, not a repository scan on every user turn. Scope hints
never grant read/export permission or replace writable scope. Missing task,
unknown/ambiguous shapes, fewer than two files, missing channel and technical
bounds give explicit skipped/unavailable/partial reasons. Off hooks are inert.
Arbitrary bash, external tools and coms/Claude peers are **not** covered.
`read`, excerpts and grep matches/line numbers remain original evidence.

## Full-list semantics

D9 requires the `distribution` capability, not global `provider_confidence`.
Real Jev choice/ordinal answers retain their supplied confidence and uncertainty;
this does not add a global Jev confidence capability or imply calibration.

Every discovered, display-permitted candidate remains a row, including low
scores and `unscored` reasons: denied, oversized, changed, unavailable, cancelled,
not_evaluated. Unknown is not relevance zero. Metadata-hidden paths contribute
only an aggregate. Sort is relevance descending, then canonical path; role does
not discard tests, configuration or documentation. There is no 255-option cap,
top-K or hidden shortlist. The 256 evaluation cap leaves other discovered rows
explicitly unscored; the candidate cap instead makes the universe incomplete.

Statuses are `complete`, `partial`, `unavailable`, `cancelled`, `skipped`.
Discovery and evaluation completeness are independent. No successful evaluation
under provider failure is unavailable, never “no relevant files”. Interrupted
traversal has `remaining: "unknown"`; cancellation reaches the real native
process. Normal failure preserves original discovery and ordinary permitted reads;
user cancellation does not start fallback work.
Broker/client request expiry and runtime job expiry are deadlines, not user
cancellation. A client rank deadline is confirmed only by the broker's deadline
reply on the same authenticated request connection after its typed cause is
latched; terminal delivery failure or no acknowledgement within the existing
1000 ms cleanup bound yields `channel_unavailable`, not a guessed deadline.
For a confirmed deadline, no successful rows yields `unavailable`; some successful rows yields
`partial`. Cancellation-derived unscored rows become `deadline`, while successful
rows and existing denial/size reasons remain. Genuine caller/task/session abort
remains `cancelled`. An advisory deadline does not kill a healthy owner or physical
attempt. Job/request budgets remain 20000 ms and discovery remains 1000 ms;
approved export/read policy is unchanged.

Large results use separately bounded managed pages with result identity, total,
offset, next locator and hash. Follow every `next` via already permitted read or
`filesystem` readback; an exhausted 64 KiB orchestrator turn needs the next turn.
No self-read budget or child tool cap is increased. A denied page path is an
explicit limitation, not delivery of all rows. A full list describes the actual
requested/discovered scope, not unseen files beyond a partial scan.

## Ownership, cache and diagnostics

One parent scheduler/cache/budget serves Hub and native jobs. Logical calls are
reserved durably before inference; failures consume reservations. Full questions,
workspace/path/hash/task/query/model/policy and current permission participate in
identity. Each waiter rechecks its own rights after await; cancelling one waiter
does not kill another. Native owner authority follows the task ID; same-task Hub
follow-ups revise Hub cache identity but not a running child's immutable query.
Advisory lease expiry stops inference, not a healthy physical child. Actual task
switch, exit, cancellation and shutdown revoke physical ownership. Broker UDS is
private and bounded, not an isolation boundary against malicious same-OS-user
processes. Provider key and inherited D9 assignments are stripped at spawn;
only trusted fresh assignments reach each physical attempt. Sandbox remains unchanged.

Fleet `1`, then `e`, enables session-only, memory-only diagnostics in the existing
viewer. D9 projection contains hashed owner/attempt, enum trigger, counts, coverage,
elapsed and actual-or-unknown attempts/usage, **no paths, queries, file bodies,
provider payload extras or capability tokens**. Shared per-file D9 requests are
not captured. Partial/failure/cancellation/skips differ from success. Observer
failure cannot alter ranking or budget. Zero calls on cache reuse does not invent
zero token usage. `d` clears capture and fences late completions.

Residual limitations: a child capability remains in its process environment for
native delegation; shell tools must not print it. Worker preparation has a bounded
job deadline and post-await kill fence, but no direct operator-kill AbortSignal.
Non-admission registration failures degrade to ordinary discovery without a D9
assignment; authoritative admission still refuses startup. A same-task follow-up
between primary and fallback can invalidate pre-spawn admission. Darwin sandbox/UDS has policy tests, not a local macOS runtime proof.
These are separate review notes, not claims of strengthened guarantees.
Mandatory policy/rules/skills, named user files, original failure evidence and
process/permission/acceptance gates remain authoritative regardless of score.

## Source/local-package selection and readiness

The following uses this unpublished checkout, **not `npx @latest`**. For another
repository set `TARGET` to its absolute path. `KEEP_FEATURES` is its complete
human-selected feature list including `system1`; `--features` replaces, not adds.
Review the preview before apply; no D9 config or consent is written by setup.

```sh
FLEET_CHECKOUT=/home/nchankov/repos/agent-fleet
TARGET=/absolute/path/to/approved-workspace
KEEP_FEATURES=system1 # include every other existing feature you intend to retain
node "$FLEET_CHECKOUT/bin/cli.js" setup --workspace "$TARGET" --features "$KEEP_FEATURES" --save-desired --dry-run
node "$FLEET_CHECKOUT/bin/cli.js" setup --workspace "$TARGET" --features "$KEEP_FEATURES" --save-desired --yes
node "$FLEET_CHECKOUT/bin/cli.js" doctor --workspace "$TARGET" --json
```

For a local tarball, create and extract outside `node_modules` (Node's type
stripper cannot import TS from inside `node_modules`), then use its CLI:

```sh
LOCAL_PACKAGE=$(mktemp -d)
(cd "$FLEET_CHECKOUT" && npm pack --pack-destination "$LOCAL_PACKAGE")
mkdir "$LOCAL_PACKAGE/unpacked"
tar -xzf "$LOCAL_PACKAGE"/chankov-agent-fleet-*.tgz --strip-components=1 -C "$LOCAL_PACKAGE/unpacked"
node "$LOCAL_PACKAGE/unpacked/bin/cli.js" setup --workspace "$TARGET" --features "$KEEP_FEATURES" --save-desired --dry-run
node "$LOCAL_PACKAGE/unpacked/bin/cli.js" setup --workspace "$TARGET" --features "$KEEP_FEATURES" --save-desired --yes
node "$LOCAL_PACKAGE/unpacked/bin/cli.js" doctor --workspace "$TARGET" --json
```

Setup copies files; it does **not** install runtime prerequisites. Before launch,
review and provision the workspace dependencies separately (these install commands
may use the network and are **not** part of the offline verification below):

```sh
(cd "$TARGET" && just fleet deps)
# Optional native directory/pattern discovery requires this exact locally resolvable Pi library.
npm install --prefix "$TARGET/.pi/harnesses" --no-save --package-lock=false @earendil-works/pi-coding-agent@0.84.2
node "$FLEET_CHECKOUT/bin/cli.js" doctor --workspace "$TARGET" --json
```

For a tarball use its extracted CLI for `doctor` instead. The library must resolve
from the copied harness, not merely exist as a global Pi executable. Installed-package
tests copy the real already-installed pinned library/dependency closure; they never
run these network-capable provisioning commands. Without the optional library,
package imports and explicit paths still work, while native discovery reports
unavailable. A missing `fd` executable is also unavailable; runtime never installs it.
See [runtime dependency setup](npm-install.md#then-install-the-runtime-dependencies).

Setup preserves human-owned `.ai/system1.json`. After separate final review and
consent, **manually merge** the D9 section above without overwriting root settings
or other consumers; use approved roots for that workspace. Supply the key through
the normal parent environment, then restart with `just fleet` from that workspace.
There is no D9 activation CLI. Setup alone never activates D9; activation takes effect in a new Hub session after explicit consent.

An offline snapshot check prints statuses only (Node with TS support required):

```sh
TARGET="$TARGET" FLEET_CHECKOUT="$FLEET_CHECKOUT" node --input-type=module -e '
const {loadSystem1Snapshot}=await import(process.env.FLEET_CHECKOUT+"/.pi/harnesses/lib/system1/config-loader.js");
const s=loadSystem1Snapshot(process.env.TARGET);
console.log(JSON.stringify({root:s.status,fileDiscovery:s.consumers.fileDiscovery.status}));'
```

Readiness is not a live inference, activation check or accuracy benchmark.
`npm run test:file-discovery` is guarded offline mechanics proof; package proof
uses a real tarball, copied workspace, guarded UDS and fake service. It proves
import closure, defaults, full-list/paging/cancellation/permissions, not semantic
accuracy, calibration, money/time savings or final independent acceptance.
