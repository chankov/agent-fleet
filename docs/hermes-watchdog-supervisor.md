# Hermes watchdog supervisor

`hub-watchdog` is an optional, foreground Python skill packaged with Agent Fleet. It is a consumer of the local Agent Hub monitor transport, not a Hermes service, Herdr controller, coms conductor, or second dispatcher.

## Current boundary and Gate O

The repository has **no proven Hermes API for an invoking chat's identity, incremental updates, wake/reconnect, or session attachment**. `hermes send --to …` selects an explicit destination; it does not prove an origin route.

Gate O has no checked-in live proof. Therefore the supported operational posture is:

- `originDelivery=false`;
- local decision journaling only;
- no chat delivery, steering, cancellation, or recovery; and
- no claim that live origin delivery, A6, or live watchdog autonomy has passed.

The capability probe and local tests validate a proposed artifact shape and fail-closed behavior only. They do not establish a real Hermes capability. Do not supply a synthetic artifact, a fixture, or an explicit `--to` target as Gate O evidence.

## Safe out-of-turn policy

Run a watch only as an explicit, foreground operator action. It must not create a background service, wake a conversation, reopen a session, select a "last chat," redirect to another route, or act while the Hub is offline. Until Gate O is independently proven, any material event or deviation is recorded locally and nothing is sent or changed. Stop the foreground process to stop observation.

The watcher has no shell, PID-search, `pkill`, Herdr, gateway, service, direct Pi-tool, or peer-delegation authority. It does not replace the Hub's task ownership. Coms cancellation remains a local wait cancellation; a remote peer can continue, so it is never an automatic recovery target.

## Installed skill and source package

`hermes/skills/hub-watchdog/` is the packaged **source artifact**, and the npm tarball also carries the backend and Desktop monitor plugin source under `hermes/plugins/` and `hermes/desktop-plugins/`. Packaging makes that source available to the installer and to a consumer that chooses to use it; it neither installs anything into a Hermes profile nor enables, launches, or configures a watcher or plugin. Installation into a profile is always an explicit opt-in operator action. The repository does not provide a supported live Hermes origin adapter.

Python test modules, bytecode, caches, and the local scenario fixtures are excluded from the tarball; the shipped Python is runtime-only and needs no dependency beyond the standard library.

The installed skill manifest defaults and caps autonomy at `observe`. The Python entrypoint also lowers `steer` or `surgical` to `observe` when Gate O is not valid. These checks are defensive code paths, not evidence that those higher tiers are approved for use.

## Profile lifecycle

Use the deterministic controller or the matching guided command:

```bash
agent-fleet set-hermes-watchdog status --profile <profile>
agent-fleet set-hermes-watchdog install --profile <profile>
agent-fleet set-hermes-watchdog update --profile <profile>
agent-fleet set-hermes-watchdog uninstall --profile <profile>
```

`status` is read-only: it reports the resolved profile, whether that profile's gateway is running, the skill state (`missing`/`current`/`drifted`), the receipt state (`managed`/`unmanaged`/`drifted`), whether a watcher lock is active, and `originDelivery: false`. It writes nothing. `--dry-run` reports the write an `install`/`update` would make without making it.

`install` and `update` behave the same way and are chosen by intent:

| Skill state | Receipt state | Result |
| --- | --- | --- |
| missing | — | Atomic install plus a mode-0600 receipt |
| current | managed | No change |
| current | unmanaged | **Adopted**: the tree is re-fingerprinted and only the receipt is written |
| current | drifted | Refused; `--force` backs the tree up and reinstalls it |
| drifted | any | Refused; `--force` backs the tree up and replaces it |

Adoption is deliberately narrow: an unmanaged tree is adopted only when a fresh, symlink-free fingerprint exactly equals the packaged source at the moment of the write. An extra file, a symlink, an unsupported entry, or any drift is refused and left untouched — adoption never rewrites the tree it adopts, and never creates a backup.

`uninstall` removes only a `current`/`managed` tree by default, moving it to `backups/agent-fleet/` and deleting its receipt; anything else requires `--force`. It preserves `watchdog.json` and every journal. An active watcher lock is reported and never killed — stop the foreground process yourself first.

An install writes the profile's default configuration only when it is absent; it never overwrites an operator's edits.

The controller resolves the selected Hermes profile but does not start, stop, restart, or kill a gateway or watcher; change Hermes tools or permissions; send a test message; or manage Herdr. Use an explicit profile when automatic profile selection is not available.

The initial configuration written only when absent is:

```json
{
  "schemaVersion": 1,
  "autonomy": "observe",
  "maximumAutonomy": "observe",
  "surgicalAllowlist": [],
  "originDelivery": "required",
  "runtimeDir": null
}
```

Keep `autonomy` and `maximumAutonomy` at `observe` while Gate O is unproven. `runtimeDir: null` is not permission to scan runtime directories; a real watch invocation needs explicit validated monitor inputs.

## Running and stopping a watch

A watch is a foreground process you start and stop yourself:

```bash
python3 <profile>/skills/hub-watchdog/scripts/watchdog.py watch --invocation-json '<json>'
```

The invocation names the profile, the validated `profileKey`/`hubKey` namespace, the hub instance, the monitor runtime directory, and the private state and lock directories. It takes a single `watch.lock` per profile under the lock directory; a second watcher for the same profile fails closed with `watcher_locked` rather than sharing state.

Send `SIGINT` (Ctrl-C) to stop it. On exit the watcher releases `watch.lock`, closes its UDS clients and any long-poll waiter, and leaves the local journal in place. It never daemonizes, re-execs, or restarts itself, and there is no service unit to disable.

## Local monitor boundary

The Hub's owner-only UDS remains the source of task state. Existing monitor operations include bounded snapshot, task output, and exact-generation cancellation; `events` and `invoke` are additive on top of that baseline. Do not interpret implementation names, cursors, discovery fields, fixtures, or unit tests as a cross-process identity proof or a live watcher guarantee. A consumer must treat malformed discovery, ownership change, unavailable transport, and reconciliation uncertainty as stop conditions for action.

### `events` and `invoke` responses

`events` replays the Hub's bounded event journal from a caller-held cursor. A request names `afterSequence`, a `limit` of 1–100, and a `waitMs` long-poll window of 0–25000. Set a read timeout that covers the window you ask the Hub to hold, otherwise a quiet poll expires locally and looks like an outage:

```json
{"ok": true, "events": {"firstAvailableSequence": 1, "latestSequence": 4, "items": [], "timedOut": true}}
```

When the cursor is older than the retained window the Hub refuses it instead of silently skipping facts, and the consumer must reconcile from a fresh snapshot and resume from sequence 0:

```json
{"ok": false, "error": "cursor_too_old", "snapshotRequired": true, "firstAvailableSequence": 9, "latestSequence": 12}
```

`invoke` submits one typed request and returns an admission status, never a result of work:

```json
{"ok": true, "result": {"status": "accepted"}}
```

`status` is one of `accepted`, `duplicate`, `queue_full`, `stale_generation`, `owner_changed`, `already_terminal`, `idempotency_conflict`, `unsupported`, or `rejected`. `accepted` means the Hub queued a visible follow-up for its operator to act on; it does not mean anything ran. A duplicate `requestId` returns `duplicate` and adds no second follow-up; the same `requestId` with different parameters returns `idempotency_conflict`.

### Owner and profile mismatch

Identity is bound on every request: the configured profile key, hub instance, and owner must all equal what live discovery reports. A mismatch — a rolled-over owner, a different profile, a stale token — is a refusal, not a fallback. The watcher must rediscover the namespace and never reuse a previous owner's token or socket, and it must never search another profile's runtime tree. An accepted request is never re-driven across a rollover or restart.

The watchdog's local journal is a decision trace, not authoritative Hub history. It must not be used to infer a task's identity, completion, route, or delivery outcome beyond what the Hub has explicitly returned.

## Migration, rollback, and incident handling

The monitor additions are intended to remain additive: older snapshot/output/cancel consumers continue to be the compatibility baseline. A consumer written against snapshot/output/cancel keeps working unchanged and needs no migration — `events` and `invoke` are new request types on the same socket, and a Hub that does not implement them answers `unsupported` rather than failing the connection.

To move such a consumer onto `events`, take a bounded snapshot first, then poll `events` from sequence 0 and treat `cursor_too_old` as an instruction to re-snapshot and restart the cursor. Keep the snapshot path: it is the only recovery route after a retention gap, an ownership change, or a reconnect. Output cursors stay per-task and are not comparable to event sequences. There is no migration that converts historical output cursors into a proven global event identity, and no migration that creates a Hermes origin route.

To roll back watchdog use:

1. set the profile configuration to `observe` (or leave the default unchanged);
2. stop the foreground watcher with `SIGINT` and confirm `watch.lock` is gone; and
3. optionally run `uninstall` only after reviewing its status/backup behavior.

Rolling back to `observe` leaves the local journal intact and stops nothing else: the Hub keeps running, no task is cancelled, and no queued follow-up is withdrawn. Rollback is always to observe-and-journal, never to a different delivery route.

Do not delete a journal, lock, runtime directory, or profile tree to force recovery. Preserve suspect files for inspection. On a transport error, Gate O failure, owner/profile mismatch, ambiguous generation, or journal problem, leave the watcher stopped or journal-only; do not retry through Herdr, a gateway restart, a shell command, or coms.

## Checks and evidence

The focused checks currently cover the capability-artifact validator, installer lifecycle, packaging boundary, and a small foreground watcher fixture. They are useful regression checks, but they do not prove live Hermes delivery, origin identity, wake/reconnect, multi-chat isolation, steering, or surgical recovery. Those claims remain blocked pending a sanitized, human-reviewed disposable live artifact naming the actual Hermes API and observed behavior.
