---
"@chankov/agent-fleet": minor
---

Make the fleet report its own transitions instead of being watched.

The Hermes panel could tell you *that* a session existed and, eventually, *that* a prompt was answered. Anything in between you had to catch by looking. `hermes/plugins/agent-fleet-herdr/dashboard/watch.py` turns consecutive `/sessions` payloads into events — `needs_answer`, `unblocked`, `finished`, `vanished`, `stale`, `dispatch_answered`, `dispatch_failed` — and hands them to two sinks: a ring buffer the pane drains into toasts, and, only when a config file says so, `hermes send`.

It is three layers on purpose. `diff_snapshots(prev, next)` is pure: no I/O, no clock of its own — time comes from the payload's `collected_at` — so every rule is testable from two hand-written fixtures. `Watcher` is the memory around it: a question must persist 20 seconds before it interrupts anyone, an identical event collapses for a minute, and past twelve events in a rolling minute a single `throttled` line says how many were dropped. Only `collect_snapshot` and the runner touch anything.

Two rules earn their weight. A herdr outage is not fleet news: when herdr stops answering every row degrades to `unknown`, so that snapshot is discarded whole and the previous one kept — the fleet is not reported as having changed once going blind and once coming back, and whatever really happened is reported on recovery, against evidence. And a question answered inside the debounce suppresses *both* its `needs_answer` and the `unblocked` that would have followed; announcing the end of something nobody was told about is exactly the noise this layer exists to remove.

`GET /events?after=<seq>` is cursor-based, bounded to 200 and per gateway process, and returns `seq` even when the list is empty so a client that fell behind resumes from the present rather than replaying a truncated past. Every `/sessions` request feeds the watcher, and the first one starts a background thread that keeps snapshotting every 15s so closing the pane does not stop the watching; `python3 watch.py --daemon` runs it without a Desktop window, and `--snapshot` prints what the watcher sees.

The Telegram sink ships default-off and does not exist unless `$HERMES_HOME/agent-fleet-watch.json` sets `telegram.enabled: true` with a target that survives validation. Target and profile are checked against a character class before they reach argv, `hermes send` is spawned as a list rather than a shell line, and sends run on their own thread behind a bounded queue so a slow subprocess can never hold up a `/sessions` request.

In the pane, `needs_answer` is a sticky warning, `vanished` an error and the rest ambient; the toast id is `(kind, project, name)`, so an agent that flaps replaces its toast instead of stacking a column. The events poll deliberately does not pause on `visibilitychange` the way the list poll does — a hidden window is when a toast is worth raising — and its first answer only sets the cursor, so opening the pane never replays history as if it were live.
