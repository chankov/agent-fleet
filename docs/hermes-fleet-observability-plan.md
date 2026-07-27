# Plan — making a running fleet visible in Hermes

Today Hermes can tell you *that* an Agent Fleet session exists and *that* a
prompt was eventually answered. It cannot tell you what any of it is doing in
between, which is the only thing a human watching a long run actually wants.
This plan closes that gap in five phases, ordered so the cheapest legibility
wins land first and the expensive transport work stays last.

**Status legend:** ☐ not started · ◐ in progress · ☑ done · ✂ dropped (with a
reason)

| Phase | Theme | Effort | Status |
|---|---|---|---|
| [1 (D)](#phase-1--d--legibility-and-truth) | Legibility and truth on the existing panel | ~0.5 day | ◐ code landed, install pending |
| [2 (C)](#phase-2--c--push-callbacks-to-hermes) | Push callbacks to Hermes (toast + Telegram) | ~0.5–1 day | ◐ code landed, install pending |
| [3 (A)](#phase-3--a--activity-tail-what-is-it-doing-right-now) | Activity tail — what is it doing right now | ~1–2 days | ◐ code landed, install pending |
| [4 (B)](#phase-4--b--agent-fleet-monitor-revive-or-archive) | `agent-fleet-monitor`: revive or archive | 2–3 days / 0.5 day | ◐ revived; code landed, restart pending |
| [5 (E)](#phase-5--e--push-transport) | Push transport instead of 3s polling | 1–2 days | ◐ code landed, restart pending |

**Update rule:** when a task lands, tick its box in place, set the phase status
in the table above, and append a dated line to the [Progress log](#progress-log).
The plan file is the tracker — do not keep the state anywhere else.

## The problem, stated precisely

A smoke test on `~/repos/agent-fleet` (2026-07-26) rendered as: one row,
`orchestrator · detached`, and two dispatches that flipped from `pending` to
`answered` minutes apart with nothing in between. Three separate causes:

1. **The vocabulary is five words.** `working / idle / blocked / detached /
   unknown` ([presentation.js:22](../hermes/desktop-plugins/agent-fleet-herdr/presentation.js#L22))
   is the entire state space the panel can express.
2. **Dispatch is fire-and-forget by design** and nothing reports on the gap:
   `pending → answered` with no elapsed time, no progress, no heartbeat.
3. **Signals that already exist are not forwarded.** The registry entry carries
   `context_used_pct`, `queue_depth` and `heartbeat_at`; the panel shows
   `model · repo`. And `started_at` is rewritten with `nowIso()` on every
   30s heartbeat ([coms/index.ts:954](../.pi/harnesses/coms/index.ts#L954),
   [agent-hub/index.ts:4183](../.pi/harnesses/agent-hub/index.ts#L4183)), so
   even "how long has this been running" is a lie.

Meanwhile the one component built for task-level progress —
`agent-fleet-monitor`, with a task tree, output cursors and generation-safe
cancel — is dormant: no launcher exports `AGENT_FLEET_PROFILE_ID` /
`AGENT_FLEET_MONITOR_RUNTIME_DIR`, so `monitorLifecycleConfig()` returns `null`
and the monitor never starts; and it is installed in no profile.

## Invariants every phase must hold

These are the rules the existing plugin already lives by. New code does not get
to relax them.

- **The output allowlist is the security boundary.** `endpoint`, `pid`,
  `session_id`, `terminal_id` stop at the backend
  ([sessions.py:32](../hermes/plugins/agent-fleet-herdr/dashboard/sessions.py#L32)).
  The renderer runs with the full privileges of the app. Anything new — a
  transcript line, a tool argument — passes an explicit allowlist, never a
  `**entry` spread.
- **Sources fail separately and never 500.** Registry unreadable → 503. herdr
  down → 200 with `unknown`. Transcript missing → 200 with `available: false`.
- **A wrong status on the right row is worse than an honest "unknown".**
- **`presentation.js` and the shared block in `plugin.js` must stay
  byte-identical** — `presentation.test.js` fails on drift. Every UI change
  edits both.
- **Presence stays best-effort but never silent.** A rejected herdr dialect
  logs `presence_dialect_rejected` to `coms-log`.
- **No message leaves the machine without an explicit opt-in.** Phase 2 sends
  Telegram; it ships default-off.
- Every phase carries **its own changeset** and its own doc update in
  [hermes-desktop-plugins.md](hermes-desktop-plugins.md).

---

## Phase 1 (D) — legibility and truth

**Goal:** every row answers "how long, how full, how fresh, and why can't you
see it" without a new data source. Fix the one field that currently lies.

### Tasks

- ☑ **Extract the live registry entry into a pure module.**
  [.pi/harnesses/lib/coms-registry-entry.ts](../.pi/harnesses/lib/coms-registry-entry.ts)
  owns `buildLiveRegistryEntry()` and the `ComsRegistryEntry` type; both
  harnesses import it and their duplicated `interface RegistryEntry` is gone.
  4 tests in `coms-registry-entry.test.ts`.
- ☑ **Fix `started_at`.** `identity` carries it from registration in both
  harnesses; the heartbeat reads it. Regression test writes twice, two hours
  apart, and asserts one `started_at` and two `heartbeat_at`.
- ☑ **Third copy: the Claude Code bridge.** `scripts/coms-claude-bridge.ts` had
  the same bug — its keepalive rebuilt the whole record with
  `started_at: nowIso()`, so every bridged Claude pane reported ≤30s of uptime.
  It now builds its `ComsIdentity` once (`bridgeRegistryIdentity()`) and feeds
  the shared `buildLiveRegistryEntry()` (`bridgeRegistryEntry()`) rather than
  keeping a third copy. Same regression shape, in
  `scripts/lib/claude-bridge-core.test.ts`. `coms-registry-entry.test.ts` was
  also missing from the `npm test` list and had never run in CI — now wired in.
- ☑ **Widen the allowlist** in `sessions.py`: `heartbeat_at`, `uptime_s`,
  `heartbeat_age_s`, `stale` (reusing `coms_registry.HEARTBEAT_FRESH_MS` rather
  than a second copy of 90s), and `workspace_id`. The payload also gained
  `herdr_panes` via a new `herdr_source.pane_snapshot()` — one `herdr agent
  list` for both the join and the count.
- ☑ **Dispatch timing.** No backend change was needed after all — the
  dispatcher already recorded `sent_at`/`answered_at` and `recent()` already
  forwarded them. The renderer was simply not reading them.
- ☑ **Row presentation.** `model · repo · ctx 12% · up 14m00s`, with the queue
  shown only when it is not empty (`q0` is the resting state and costs 4
  characters in a 300px pane). A stale heartbeat is its own sentence on its own
  line, never a colour.
- ☑ **Explain `detached`.** `sessionNote()`: "herdr reports no panes at all" /
  "none of 7 herdr panes reports it" / the vaguer sentence when the payload
  predates the count. A stopped heartbeat outranks all three.
- ☑ **Pending dispatch elapsed timer.** `presentDispatch(dispatch, nowMs)`
  ages a pending dispatch against now and freezes a finished one at what it
  took. `useNow()` ticks only while something is pending.
- ☑ **Focus button.** `POST /sessions/{project}/{name}/focus` →
  `herdr workspace focus`. Workspace resolved server-side from a fresh herdr
  answer; the id is validated before it reaches argv; 422 for a peer no pane
  hosts. Offered in the composer header (a button inside the row button would
  be invalid HTML) and only when herdr currently reports a pane.
- ☑ **Mirror the shared block into `plugin.js`** — spliced programmatically, drift test green.
- ✂ **Install into the `default` profile** — dropped 2026-07-27 by decision:
  the plugin stays a `dev`-profile tool. It had in fact been symlinked into
  `default` as well (both halves, plus the `plugins.enabled` record); that was
  undone rather than kept. The smoke test moves to `dev`, and Desktop has to be
  launched on that profile (`hermes -p dev desktop`) for the pane to see it.
- ☑ Doc + changeset (`.changeset/fleet-panel-legibility.md`).

### Verification

```bash
node --test --experimental-strip-types .pi/harnesses/lib/coms-registry-entry.test.ts
for t in hermes/plugins/agent-fleet-herdr/dashboard/*.test.py; do python3 "$t" || break; done
node --test hermes/desktop-plugins/agent-fleet-herdr/presentation.test.js
```

The same three commands verify Phase 2 — `watch.test.py` is picked up by the
glob, and the drift check between `presentation.js` and `plugin.js` is inside
the presentation suite.

**Done when:** a live session shows uptime that grows, context that moves, and a
pending dispatch whose age is visible; a killed pane reads `detached` with the
reason attached.

---

## Phase 2 (C) — push callbacks to Hermes

**Goal:** stop watching the panel. The fleet reports its own transitions — this
is the "callback Hermes" half of the original task, and it is the part that was
never built.

### Design

`watch.py` is a **pure transition detector**: `diff_snapshots(prev, next) ->
[Event]`. No I/O, no clock of its own, fully testable from fixtures.

| Event | Fires when |
|---|---|
| `needs_answer` | a row enters `blocked` and stays there past the debounce |
| `unblocked` | it leaves `blocked` |
| `finished` | a session that existed is gone and its last state was not an error |
| `vanished` | a session disappears while `working` — the interesting failure |
| `stale` | heartbeat older than 90s while the process still exists |
| `dispatch_answered` / `dispatch_failed` | a tracked dispatch reaches a terminal state |

Two sinks, both fed from the same event list:

1. **In-app** — a bounded ring buffer behind `GET /events?after=<seq>`; the pane
   raises `host.notify({ kind, message })` for anything it has not shown.
2. **Telegram** — `hermes send --to <target>`, spawned exactly as
   [coms-hermes-bridge.ts:125](../scripts/coms-hermes-bridge.ts#L125) does it.
   **Default off.** Opt-in through a config file with an explicit `enabled: true`
   and a target; absent config means the sink does not exist.

Runner: a background thread started lazily by the first `/sessions` request
(the gateway is already the process that polls), plus a standalone
`python3 watch.py --daemon` entry point for anyone who wants it under systemd
without a Desktop window open.

### Tasks

- ☑ `watch.py` — pure `diff_snapshots`, frozen `Event`, sequence numbers assigned
  by the buffer rather than the detector. Time comes from `collected_at`; the
  first snapshot announces nothing.
- ☑ Debounce and rate limits: `blocked` must persist ≥ 20s; a question answered
  inside that window suppresses **both** `needs_answer` and its `unblocked`;
  identical `(kind, project, name)` collapses for 60s; 12 events per rolling
  minute, past which one `throttled` event says how many were dropped.
- ☑ Ring buffer (200) + `GET /events?after=<seq>`, with `seq` returned even on
  an empty answer so a client behind the buffer resumes from the present.
- ☑ Telegram sink behind explicit config (`$HERMES_HOME/agent-fleet-watch.json`,
  `telegram.enabled: true` + a validated target). Absent config, absent sink.
  Sends run on their own thread behind a bounded queue, so `hermes send` can
  never hold up a `/sessions` request.
- ☑ Background runner (lazy, 15s, `AGENT_FLEET_WATCH_INTERVAL=0` to disable) +
  `python3 watch.py --daemon`, plus `--snapshot` for "what does the watcher
  actually see".
- ☑ Pane consumes `/events` every 5s — deliberately NOT paused on
  `visibilitychange`, unlike the list poll — and raises `host.notify` with a
  `(kind, project, name)` id so a flapping agent replaces its toast. The first
  answer only sets the cursor. `needs_answer` rows already sort first in
  `sessions.py`; the toast points at the top of the list.
- ☑ `watch.test.py` — 30 tests: unchanged snapshot, one event per transition,
  debounce suppression (both halves), flood cap and its own throttle, a herdr
  outage producing **no** events plus the recovery that reports what really
  happened, and the sink refusing every half-written config.
- ☑ Doc + changeset (`.changeset/fleet-watch-callbacks.md`).
- ☐ **Install + restart** — same gate as Phase 1: `/events` is a backend route,
  so it does not exist until Hermes Desktop restarts, and the pane will log a
  404 for it until then.

**Done when:** a hub that blocks on a question reaches the phone without the
Desktop window being open, and a finished smoke test announces itself.

---

## Phase 3 (A) — activity tail: what is it doing right now

**Goal:** the real answer to the original complaint. Reads a source that is
already written for every pi session; needs nothing from the hub, herdr, or a
lease.

### Design

`~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl` holds every message —
including `toolCall` entries — and `custom` records with
`customType: "coms-log"`, whose `boot` event carries `session_id`, `name` and
`project`.

- **The mapping is authoritative through `boot`, not through the slug.** The
  slug (`/home/x/repo` → `--home-x-repo--`) narrows the search; the match is
  `coms-log/boot.session_id == registry.session_id`. Resumed sessions and
  multiple transcripts per cwd make any slug-only rule wrong.
- **Bounded reads only.** Tail the last ~256 KB, never parse a whole file.
  Cache `(path, size, mtime) -> parsed tail`.
- **Projection, not forwarding.** Each step becomes
  `{ seq, at, kind, label, detail }` where `kind ∈ tool | assistant | dispatch |
  blocked | done`. Tool arguments pass a **per-tool allowlist** — `bash` gives a
  truncated command, `read` gives a path, `dispatch_agent` gives the target —
  because a transcript contains everything the agent has ever seen and the
  renderer is not the place to spill it.

`GET /sessions/{project}/{name}/activity?after=<seq>&limit=50` →
`{ available, steps, current: { label, since }, seq }`. `available: false` when
no transcript can be matched — a normal answer, never an error.

### Tasks

- ☑ `activity.py`: slug derivation (a port of pi's own `migrations.js:101`
  encoding, character for character), candidate scan newest-first, `boot`-based
  match, two bounded LRU caches.
- ☑ Tail reader with a byte budget and partial-line tolerance. Both ends are
  cut: the first line whenever the read started mid-file, the last unless it
  ended in a newline.
- ☑ Step projection + per-tool argument allowlist. `thinking`, `toolResult` and
  `user` turns never travel at all; an unlisted tool yields its name and nothing
  else; a dict where a string was expected renders as nothing rather than being
  `str()`d into the payload.
- ☑ `GET …/activity` endpoint. **Never any error but `422` on a malformed
  name** — no transcript, no registry entry and an unreadable file are all a 200
  with `available: false` and a reason.
- ☑ Pane: the modal — not the row — carries the live timeline, and its
  description line becomes `working · 3m12s · bash git rev-list…`. Per-row
  polling was rejected: a transcript read per row per 3s turns a status panel
  into a disk load, and opening a session is the request for detail.
- ☑ `activity.test.py` — 41 tests on a temp tree, including all six named cases
  plus the allowlist leak tests and the limit landing inside a line.
- ☑ **3b:** bridged Claude Code peers. This needed a link that did not exist:
  `coms-claude-bridge.ts` mints its own coms session id and Claude Code has never
  heard of it, so there was no shared identifier on disk and a slug-only rule
  would have been the exact guess this phase refuses to make.
  `hooks/coms-stop-hook.mjs` now writes `transcript_path` into the record the
  bridge already watches (additive; `HookRecord` has an index signature), and
  the reader follows registry → herdr pane → hook → `~/.claude/projects/*.jsonl`
  with a second dialect (`tool_use`/`input`, PascalCase names, `stop_reason`)
  behind the same projection. Consequence stated rather than hidden: the chain
  runs through the pane, so a **detached Claude Code peer cannot be matched at
  all** — the opposite of the pi case. The herdr lookup runs only for
  `model: "claude-code"`, so a pi peer never pays for it.
- ☑ Doc + changeset (`.changeset/fleet-activity-tail.md`).
- ☐ **Install + restart** — the same gate as Phases 1 and 2. `/sessions/…/activity`
  is a backend route and routers mount at app construction, so it 404s until
  Hermes Desktop restarts on the `dev` profile. The renderer names that
  specifically ("Restart Hermes Desktop to pick up the activity route") rather
  than showing a status code.

### Verification

```bash
for t in hermes/plugins/agent-fleet-herdr/dashboard/*.test.py; do python3 "$t" || break; done
node --test hermes/desktop-plugins/agent-fleet-herdr/presentation.test.js
python3 hermes/plugins/agent-fleet-herdr/dashboard/activity.py <project> <name>
```

The last line prints exactly what the panel would be shown for one live peer —
the fastest way to tell "no transcript" from "the wrong transcript".

**Done when:** a `detached` session — no pane at all — still shows what it is
doing, because the transcript is on disk regardless of who is watching. True for
pi peers; for bridged Claude Code peers the link runs through the pane, so
`detached` is where their tail stops.

---

## Phase 4 (B) — `agent-fleet-monitor`: revive or archive

**Goal:** end the half-life. Two live monitoring stacks cost more than either
of them; this phase is a decision with two exits, taken **after** Phase 3 shows
how much of the need it already covers.

**Decided 2026-07-27: Exit 1, revive.** Yes — cancel and raw output are wanted,
and the evidence gathered before deciding was that reviving is cheaper than the
estimate implied: the monitor is already wired into `agent-hub` at twelve call
sites and only ever failed to *start*. Archiving would have deleted ~95 KB of
source behind 40 test files to remove a capability the activity tail cannot
replace.

### Exit 1 — revive

- ☑ **Export `AGENT_FLEET_PROFILE_ID` / `AGENT_FLEET_MONITOR_RUNTIME_DIR` from
  the launchers.** [scripts/lib/monitor-env.ts](../scripts/lib/monitor-env.ts)
  resolves both (`dev`; `$XDG_RUNTIME_DIR/agent-fleet-monitor` created 0700, a
  uid-scoped tmpdir when there is no `XDG_RUNTIME_DIR`), `fleet.ts` merges them
  into every mode, and `team-up.ts` passes them as **pane env** — the one thing
  the plan did not anticipate: a `just fleet team` hub is spawned by a herdr
  daemon that inherits nothing from the launcher's shell, so inheritance alone
  would have missed the launcher most likely to want a task tree. An operator's
  own export always wins; `AGENT_FLEET_MONITOR=0` opts out; a directory that
  cannot be made 0700 leaves the hub unmonitored rather than handing the Python
  reader a path it will refuse. 8 tests in `monitor-env.test.ts`. The `justfile`
  needed no change — it inherits.
- ☑ **Confirm the lease/discovery handshake.**
  `scripts/lib/hermes-monitor-plugin-handshake.test.ts` runs the real registry
  and socket server in Node and a real `python3` over `tasks.py` against them:
  launcher env → 0700 runtime dir → 0600 discovery + token → UDS → adapter →
  tree → pane join → allowlist. The one trap: `spawnSync` blocks the event loop
  the socket server runs in, so the request connects and nothing ever answers.
- ✂ **Install the plugin** — dropped, and the fold is why. `tasks.py` reaches
  `adapter.py` as a sibling in the checkout rather than through Hermes' plugin
  loader, so neither monitor half needs to be installed at all. Verified through
  the installed symlink: `~/.hermes/profiles/dev/plugins/agent-fleet-herdr`
  resolves the adapter back into the repo. Not installing the monitor's Desktop
  panel is the same decision as "one pane", stated once.
- ☑ **Replace the single-`<li>` renderer with a real task tree, folded into the
  herdr pane.** `presentTasks()` flattens the (at most two-level) forest to rows
  carrying their own `depth`, paired with `aria-level`; the modal renders each
  live child's stdout under it. The description line gains the running count —
  a hub whose own transcript is idle while three specialists work was exactly
  the case the panel rendered as "nothing is happening".
- ☑ **Keep Cancel.** `POST …/tasks/{id}/{gen}/cancel`. The id the renderer hands
  over is re-derived against a fresh snapshot scoped to that agent's pane before
  it reaches the socket, and the hub comes from the snapshot rather than the
  request — without that the route would stop any task in any hub on the machine
  for anyone who could guess an id.
- ☑ Doc + changeset (`.changeset/fleet-monitor-revive.md`).
- ☐ **Install + restart** — the same gate as Phases 1–3. `…/tasks` and its
  cancel are backend routes, so they 404 until Hermes Desktop restarts on the
  `dev` profile. The renderer names that specifically ("Restart Hermes Desktop
  to pick up the tasks route") rather than showing a status code.

### Exit 2 — archive

Not taken. Left in place as the record of what was weighed.

- ✂ Remove `hermes/plugins/agent-fleet-monitor`, `hermes/desktop-plugins/agent-fleet-monitor`
  and the `monitor-*.ts` surface from `agent-hub` (a large, test-covered removal).
- ✂ Record the decision as an ADR — what it did, why the activity tail replaced
  it, and what was lost (per-generation cancel).
- ✂ Changeset: **major**, it removes a documented transport.

### Verification

```bash
npm test
for t in hermes/plugins/agent-fleet-herdr/dashboard/*.test.py hermes/plugins/agent-fleet-monitor/dashboard/*.test.py; do python3 "$t" || break; done
node --test hermes/desktop-plugins/agent-fleet-herdr/presentation.test.js
```

**Done when:** selecting a hub's row shows the specialists it spawned, what each
is printing, and a button that stops one. True for a hub in a herdr pane; a
`detached` hub shows no tasks, because the correlation runs through the pane.

---

## Phase 5 (E) — push transport

**Goal:** latency, only once there is something worth pushing. Not before.

### Tasks

- ☑ **FastAPI WebSocket at `/events/stream`, fed by the Phase 2 watcher.**
  `Watcher.subscribe()` fans each emitted batch out to live listeners on
  whichever thread observed the snapshot; `EventStream` is one socket's view of
  that — backlog past `after`, then frames, then an empty `keepalive` every 20s
  of silence. It **subscribes before reading the backlog**, because the other
  order can lose an event that lands between the two while this order can only
  duplicate one — and every frame is filtered against the cursor. Its queue is
  bounded at 64 batches and drops rather than growing; a dropped batch arrives
  late through the poll rather than never.
- ☑ **The route had to authenticate itself** — the one thing the plan did not
  anticipate. Every gateway middleware, the auth gate *and* the
  plugins-enabled 404, is registered for the `http` scope, so a WebSocket
  upgrade reaches a plugin router with **nothing checked**. `_socket_gate()`
  re-runs the gateway's own `_ws_request_is_allowed` / `_ws_auth_ok` out of
  `sys.modules` plus the enabled check, and **refuses when it cannot resolve
  them**: a Hermes that renames those gets no stream and a pane that keeps
  polling, rather than an upgrade quietly turning this into an unauthenticated
  event feed.
- ☑ **Keep the poll as the fallback** — `ctx.socket` is a documented no-op on
  OAuth remotes, so the poll is the contract and the socket is the accelerator.
  Implemented as a cadence, not a switch: `shouldPollEvents()` steps `/events`
  from every 5s down to every 30s while frames arrive and back up the moment
  they stop, so nothing has to detect a broken socket. Both feeds share one
  handler and one cursor, and `presentEvents(payload, primed, after)` filters by
  `seq`, so an event delivered twice is a wasted frame, never a second toast.
- ☑ `/capabilities` gains `events_stream: true` — not a source, the version
  marker: routes mount at app construction, so its presence is the honest answer
  to "has Hermes restarted since the plugin changed".
- ✂ **The `herdr agent list` socket client** — dropped 2026-07-27 on the plan's
  own criterion. Seven runs of that command measured 3.1–4.6ms, so the poll is
  not measurably in the way; the doc's earlier "~20ms" guess was pessimistic by
  a factor of five. Reimplementing herdr's JSON-lines protocol in Python to save
  4ms every 3 seconds is not a trade worth making.
- ☑ Doc + changeset (`.changeset/fleet-events-push.md`).
- ☐ **Install + restart** — the same gate as Phases 1–4, and the last one.
  `/events/stream` is a backend route; both halves are already symlinked into
  the `dev` profile and enabled, so all that is outstanding is
  `hermes -p dev desktop` being restarted. Until then `ctx.socket` finds no
  route, the pane logs nothing, and the 5s poll carries the events exactly as it
  did before this phase — which is the fallback doing its job.

### Verification

```bash
python3 hermes/plugins/agent-fleet-herdr/dashboard/watch.test.py
~/.hermes/hermes-agent/venv/bin/python hermes/plugins/agent-fleet-herdr/dashboard/plugin-api.test.py
node --test hermes/desktop-plugins/agent-fleet-herdr/presentation.test.js
curl -s "$HERMES_URL/api/plugins/agent-fleet-herdr/capabilities" | grep events_stream
```

The last line is the restart check: no `events_stream` key means the gateway is
still running the code from before this phase.

**Done when:** a question that blocks an agent reaches the pane as a toast in
the time it takes the watcher to see it, rather than up to 5 seconds later — and
pulling the socket down changes nothing except that latency.

---

## Progress log

Newest last. One line per landed task or decision: date, phase, what changed,
what proved it.

- 2026-07-26 — plan written from the smoke-test findings; nothing implemented yet.
- 2026-07-26 — **Phase 1 code complete.** Shared `buildLiveRegistryEntry()` in
  both harnesses (`started_at` no longer rewritten every 30s); backend forwards
  `heartbeat_at`, `uptime_s`, `heartbeat_age_s`, `stale`, `workspace_id` and
  `herdr_panes`; panel shows context/queue/uptime, explains `detached`, ages
  pending dispatches, and can focus a peer's workspace. Proof: 5/5 Python
  suites, 33 presentation tests, 38 harness-lib tests, `npm test` 562 pass.
- 2026-07-26 — Phase 1 remains ◐ until the plugin is installed into the
  `default` profile and Hermes Desktop is restarted — a backend edit cannot
  reach a running pane, and the smoke test that started this ran on `default`
  where the plugin is not installed at all.
- 2026-07-26 — Smoke test after the change showed `alive, but no herdr pane
  reports it` for a peer that visibly HAD a pane. Not a join bug: the current
  code, run against the live sources, resolves that pane exactly
  (`('test1','orchestrator') -> wA:p1X`, state `idle`, uptime 223s). The Desktop
  gateway mounted its routers at 21:23:31 and the backend files changed at
  22:20; the renderer hot-reloaded and the backend did not. The vague sentence
  IS the signature of that mismatch — it is only reachable when `herdr_panes` is
  missing from the payload. Documented in hermes-desktop-plugins.md; still
  waiting on a Desktop restart.
- 2026-07-26 — Noted in passing, NOT fixed: `.pi/harnesses/agent-hub/monitor-publisher.test.ts`
  fails on a clean checkout too (`parent task turn-monitor-smoke was not
  found`). Pre-existing, unrelated to this phase, and evidence for the Phase 4
  decision.
- 2026-07-27 — **Sending withdrawn from the pane; a row now opens a modal.**
  The composer is gone; `presentSessionMenu()` replaces `presentComposer()` and
  returns actions as a list, of which `Focus pane` is the only one for now. An
  impossible action is disabled with its reason rather than hidden. The backend
  write door (`POST …/prompt`, the `Dispatcher`, the reply sockets) is untouched
  and uncalled — it is also what feeds the `dispatch_*` events. Proof: 40
  presentation tests including the byte-identical drift check.
- 2026-07-27 — **Phase 2 code complete.** `watch.py`: pure `diff_snapshots`, a
  `Watcher` holding the 20s debounce / 60s collapse / 12-per-minute cap / 200-
  event ring buffer, `GET /events?after=<seq>`, a lazy 15s background runner and
  a `--daemon` entry point, and an opt-in `hermes send` sink that does not exist
  without config. The pane drains `/events` into `host.notify`. Proof: 30 new
  Python tests (133 across six suites), 40 presentation tests, 38 harness-lib
  tests, `npm test` 569 pass.
- 2026-07-27 — Both phases now wait on the same human step: a Hermes Desktop
  restart. `/events` is a backend route and routers mount at app construction,
  so it 404s until then. The renderer degrades quietly (a failed `/events` poll
  is ignored — the header already reports a backend that is down), which means
  the symptom of a missing restart is "no toasts ever", not an error.
- 2026-07-27 — **Phase 3 code complete.** `activity.py` reads a session's own
  transcript and projects it into `{seq, at, kind, label, detail}` steps behind a
  per-tool argument allowlist; `GET …/activity?after=<seq>` is cursor-based on a
  byte offset into the file and returns no errors at all. The modal carries the
  timeline and its description line now reads `working · 3m12s · bash git
  rev-list…`. Proof: 41 new Python tests (184 across seven suites), 48
  presentation tests including the byte-identical drift check, `npm test` 577
  pass.
- 2026-07-27 — **3b needed a link that did not exist, not just a second
  reader.** The plan assumed "the same reader shape over `~/.claude/projects/`".
  It is not the same: a bridged Claude Code peer has no `boot` record, because
  `coms-claude-bridge.ts` mints its own coms session id (`ulid()`) and Claude
  Code has never heard of it. Nothing on disk connected the two, so the only
  available rule would have been "newest transcript in this cwd" — the exact
  guess this phase exists to refuse. The fix was upstream: the Stop hook already
  had `transcript_path` in hand and was dropping it, so it now writes it into the
  record the bridge already watches. The chain is registry → herdr pane → hook →
  transcript, which means a *detached* Claude Code peer has no tail — recorded as
  a limit rather than smoothed over.
- 2026-07-27 — Noted in passing, NOT fixed: `scripts/coms-claude-bridge.ts:188`
  rewrites its registry record every 30s keepalive with `started_at: nowIso()` —
  the same lie Phase 1 fixed in the two pi harnesses, still live in the Claude
  bridge. Every bridged peer therefore reports an uptime of at most 30s. Spun
  out as its own task; the fix is to reuse `buildLiveRegistryEntry()` rather than
  add a third copy.
- 2026-07-27 — **Decision: `dev` profile only.** The `default` profile had both
  halves symlinked and enabled since 2026-07-26 22:46; that install is being
  removed. Consequence to remember: `$HERMES_HOME` is the profile path, so the
  watcher's opt-in config for this fleet lives at
  `~/.hermes/profiles/dev/agent-fleet-watch.json`, not `~/.hermes/`.
- 2026-07-27 — **Claude bridge `started_at` fixed** (the item spun out above).
  `coms-claude-bridge.ts` now builds its `ComsIdentity` once at registration
  (`bridgeRegistryIdentity()`) and rebuilds only the live fields each keepalive
  through the shared `buildLiveRegistryEntry()` (`bridgeRegistryEntry()`) — no
  third copy. Proof: the regression test in `scripts/lib/claude-bridge-core.test.ts`
  fails against the old inline record and passes against the new one (verified by
  reintroducing the bug); `npm test` 583 pass. Found while wiring it up:
  `.pi/harnesses/lib/coms-registry-entry.test.ts` was never added to the `npm test`
  list, so Phase 1's own regression test had never run in CI. Now added — that is
  where the 562 → 583 count comes from, not just the new tests.
- 2026-07-27 — **Phase 4 decided: revive.** The evidence that settled it was
  that the monitor is not half-built, it is fully built and never started:
  `agent-hub/index.ts` publishes into it from twelve call sites (child start,
  output, finalize, operator kill, lease) and `monitorLifecycleConfig()` returns
  `null` because nothing exported its two variables. Archiving would have
  deleted ~95 KB of source behind 40 test files to lose the one capability the
  activity tail cannot provide. Also weighed: local cancel already works in the
  hub without the monitor (`cancelLocalOwnedProcess` runs with a null bridge),
  so what the monitor uniquely adds is *remote* cancel and raw stdout.
- 2026-07-27 — **Phase 4 code complete.** Launchers export the monitor
  variables (`scripts/lib/monitor-env.ts`); the herdr panel serves
  `GET …/tasks` and `POST …/tasks/{id}/{gen}/cancel` from `tasks.py`, joined to
  a hub by `hubPaneId`; the selected row's modal carries the subagent tree with
  per-child stdout and a Cancel. Proof: 23 new Python tests in `tasks.test.py`
  plus 10 route tests (233 across ten suites, both plugins), 8 presentation
  tests for `presentTasks` (56 total, drift check included), and a cross-language
  handshake test — `npm test` 603 pass, up from 583.
- 2026-07-27 — **The parent key needed the hub in it.** `FleetMonitorAdapter`
  merges every hub registered under the profile into one task list, and nothing
  stops two hubs from calling a turn `turn-1`. Matching a parent on
  `(id, generation)` alone hung this pane's specialists under the other hub's
  turn — caught by adding the case, and confirmed by reverting the key and
  watching it fail 2 != 1 before restoring it.
- 2026-07-27 — **`team-up.ts` needed pane env, not inheritance.** The plan said
  "export from the launchers" and inheritance covers `just fleet hub`. It does
  not cover `just fleet team`: that hub pane is spawned by the herdr daemon,
  which was started from some other shell at some other time and inherits
  nothing. The launcher most likely to want a task tree would have been the one
  silently without one.
- 2026-07-27 — **"Install the plugin" turned out to be unnecessary, which is
  also what makes "one pane" true.** `tasks.py` imports the monitor's
  `adapter.py` as a sibling in the checkout rather than through Hermes' plugin
  loader — ~60 lines of 0700/0600 discovery is not worth a second copy —
  so neither monitor half is installed in any profile. Verified through the
  installed symlink rather than assumed.
- 2026-07-27 — **Two tests had been stranded by earlier refactors, both
  fixed and both now in `npm test`.** `monitor-publisher.test.ts` omitted
  `parentGeneration`, so `MonitorStore.createChild` could not find the parent —
  the assertion that had been red on a clean checkout since before this plan
  was written covers exactly the pane correlation Phase 4 depends on.
  `review-live-wiring.red.test.py` asserted a bounded cancel response against
  `scripts/lib/hermes-monitor-socket.ts`, which is now a two-line `export *`
  shim; it proved only that the shim was short. Neither was a source bug.
- 2026-07-27 — **Phase 5 code complete.** `WS …/events/stream?after=<seq>`
  serves the Phase 2 ring buffer as it fills: `Watcher.subscribe()` plus an
  `EventStream` per socket (backlog, then frames, then a 20s keepalive), and the
  pane runs socket and poll through one handler and one cursor. Proof: 12 new
  Python tests in `watch.test.py` (30 → 42) and 13 in `plugin-api.test.py`
  (38 → 51) — 258 across both plugins, up from 233 — plus 5 new presentation
  tests (61, drift check included); `npm test` 608 pass, up from 603.
- 2026-07-27 — **A plugin WebSocket is not gated by anything.** The assumption
  behind "just add `ctx.socket`" was that the route inherits the protections the
  REST routes have. It does not: every gateway middleware is registered for the
  `http` scope, so both the auth check and the plugins-enabled 404 are skipped
  on an upgrade, and a plugin that adds a socket without noticing has published
  an unauthenticated feed on the gateway port. The gate is re-done in
  `plugin_api._socket_gate()` with the gateway's own functions, and it fails
  **closed** — which is only affordable because the poll never stopped.
- 2026-07-27 — **The poll was kept as a cadence, not a fallback path.** A
  socket that "takes over" needs something to notice when it dies, and
  `ctx.socket` gives its caller no close event — only frames. So the poll runs
  unconditionally and merely slows to 30s while frames are fresh, which also
  turns out to be what makes a bounded per-socket queue safe: dropping a batch
  costs latency instead of losing an event, because both feeds share the cursor.
- 2026-07-27 — **Two shared-state bugs in the tests, one real lesson.** The new
  socket tests initially failed for a reason that was not about sockets: the
  process-wide `_watcher` in `plugin_api` is shared across every test in the
  file, and the watcher's 60s collapse window hands an identical transition to
  whichever test runs first. Two tests ending the same session are one event.
  Fixed by patching a fresh `Watcher` per test — and it also cut the suite from
  40s to 0.6s, because the tests that lost the race had been waiting out the
  20s keepalive.
- 2026-07-27 — **The optional half was dropped on a measurement, not a
  preference.** `herdr agent list` runs in 3.1–4.6ms (seven runs), so the poll
  it would replace is not measurably in the way — the plan's own condition. The
  doc's standing "~20ms" estimate was five times pessimistic and is corrected.
