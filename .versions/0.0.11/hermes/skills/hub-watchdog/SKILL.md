---
name: hub-watchdog
description: Foreground, fail-closed local Agent Hub watchdog. Use only for explicit operator observation of a profile-scoped Hub through its authenticated monitor socket.
---
# Hub Watchdog

`hub-watchdog` is a packaged source skill, not a service or an enabled Hermes integration. Run it only as an explicit foreground operator action:

```bash
python3 scripts/watchdog.py status --invocation-json '<json>'
python3 scripts/watchdog.py validate-config --invocation-json '<json>'
python3 scripts/watchdog.py watch --invocation-json '<json>'
```

`status` and `validate-config` report the resolved autonomy tier and delivery disposition without connecting to anything. Run them before `watch` and stop if either reports something you did not intend.

Default and maximum autonomy are `observe`. Send `SIGINT` to stop the foreground process; it releases its per-profile `watch.lock`, closes its socket clients and any long-poll waiter, and leaves the local journal in place. Do not create a daemon, schedule it, wake/reopen a Hermes session, or use a last-chat/default-route fallback. A second watcher for the same profile fails closed with `watcher_locked` rather than sharing state.

## Discovery is profile-scoped

Read exactly one discovery record from the namespace the invocation names — the validated profile key and hub key under the configured runtime directory. Never scan a runtime root, walk sibling profiles, or fall back to another namespace when a lease is expired, a token is missing, or a socket is gone. An unsafe runtime mode, a symlink, a world-readable token, an expired lease, or more than one discovery entry is a refusal.

Identity is bound on every request: the configured profile key, hub instance, and owner must all equal what live discovery reports. A mismatch is a refusal, not a fallback. After an owner rollover, rediscover from scratch; never reuse the previous owner's token or socket, and never re-drive a request that was already accepted.

## Gate O: currently closed

There is no checked-in genuine live proof of a Hermes originating-chat identity, incremental-update, wake/reconnect, or session API. `hermes send --to` is an explicit destination only; it is not origin evidence. A validator, fixture, fake adapter, or local UDS test cannot close Gate O.

Until a sanitized, human-reviewed disposable live artifact names the real API and proves the required behavior, operate journal-only:

- do not send chat updates, including out-of-turn status messages;
- do not steer, cancel, or recover work;
- do not claim live delivery, A6, or higher-tier autonomy; and
- do not redirect when a route is unavailable.

The entrypoint lowers requested `steer`/`surgical` autonomy to `observe` when Gate O is invalid. That safeguard does not authorize higher tiers when an artifact merely looks valid.

## Evidence and judgment stay bounded

Base every decision on the events the Hub actually returned. Cite them by event id, keep the cited set small, and record the deviation you believe they show. A judgment adapter is optional; when present it may only select one action from the closed set, and any malformed verdict resolves to `none`. Never infer a task's identity, completion, route, or delivery outcome beyond what the Hub explicitly returned, and never treat your own journal as Hub history.

If a cursor falls outside the retained window, reconcile from a fresh snapshot and resume — do not guess at the events you missed.

## Durability precedes transport

Before the first transport call for any action, persist the canonical request digest and the proposed decision. If that write fails, refuse — do not send. An ambiguous transport failure is never retried: one bounded attempt, then refuse and let an operator decide.

## Recovery is exact-generation only

Recovery is available only at `surgical` autonomy with Gate O open, only for an allow-listed native task, and only through the narrow monitor adapter. The sequence is fixed: persist the proposal, re-read a fresh snapshot, cancel exactly generation N, observe N reach a terminal state, re-read a fresh snapshot again, then enqueue at most one recovery request. A newer generation observed at any point freezes the transaction as `superseded`. A missing owner, profile, or hub identity is a refusal, not a wildcard. A completed step is never repeated after a restart, and a timeout, a refused cancel, a rejected enqueue, or an unobserved exit never retargets or retries.

Coms runs have no recovery path at all. Cancelling one abandons only the local wait; the remote peer may continue.

## Boundaries

The watcher reads owner-only monitor discovery and UDS responses, writes a local decision journal, and may render bounded local summaries. Hub state remains authoritative. A journal, event cursor, discovery field, or local test is not independent proof of task identity, ownership, route identity, completion, or delivery.

Never shell out, search PIDs, use `pkill`, control Herdr, manage a gateway/service, invoke Pi tools directly, or delegate through coms. Do not turn a coms wait cancellation into peer cancellation or automatic recovery. Keep tokens in memory only: never write one to a journal, log, argument, or summary.

On malformed or unavailable monitor data, ownership/profile uncertainty, reconciliation uncertainty, journal trouble, or Gate O failure, fail closed: keep or return to local journal-only operation and ask an operator to inspect the issue.

## Summaries for a human

A summary is for the operator reading it, so write it in their language — Bulgarian when that is what they use — and keep the identifiers untranslated: task ids, generations, event ids, and states stay verbatim so they can be matched against the Hub. Say what was observed and what was journaled. Never describe a queued request as work that ran, and never present local runtime evidence as proof of live delivery.

## Install lifecycle

Use `agent-fleet set-hermes-watchdog status|install|update|uninstall --profile <id> [--force] [--dry-run]` or the matching guided command. `status` is read-only. Install/update are profile-artifact operations; drift is refused unless an operator explicitly selects backed-up `--force`. An identical unmanaged tree is adopted by writing only a receipt, and only when a fresh symlink-free fingerprint exactly equals the packaged source. Uninstall preserves configuration and journals and reports, rather than kills, an active lock.

None of these lifecycle actions starts, stops, restarts, or kills Hermes or the watcher; changes Hermes tools/permissions; sends a test message; or manages Herdr. Packaging the skill does not install or enable it.

## Rollback

To stand down: set the profile configuration back to `observe` (or leave the default), `SIGINT` the foreground watcher, and confirm `watch.lock` is gone. That leaves the journal intact, cancels nothing, and withdraws no queued follow-up. Run `uninstall` only after reviewing its status and backup behavior. Never delete a journal, lock, runtime directory, or profile tree to force recovery — preserve suspect files for inspection.

See `docs/hermes-watchdog-supervisor.md` for the configuration example, the `events`/`invoke` responses, the migration path, and the evidence boundary.
