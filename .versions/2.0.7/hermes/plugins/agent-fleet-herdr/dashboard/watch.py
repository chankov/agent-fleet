"""The fleet reports its own transitions instead of being watched.

A panel you have to keep open is a panel you stop opening. This module turns
consecutive `/sessions` payloads into a short list of things that HAPPENED —
someone is stuck on a question, a session ended, a heartbeat stopped — and hands
them to two sinks: a ring buffer the pane drains into toasts, and, only when it
is explicitly configured, `hermes send` for the phone.

Three layers, deliberately separate:

  diff_snapshots(prev, next) -> [Event]   pure. No I/O, no clock of its own —
                                          time comes from `collected_at` — so
                                          every rule is testable from fixtures.
  Watcher                                 the memory: the 20s debounce on
                                          `needs_answer`, event collapse, the
                                          per-minute cap, sequence numbers and
                                          the bounded buffer.
  EventStream                             one subscriber's view of that buffer,
                                          shaped for a WebSocket: the backlog it
                                          missed, then frames as they happen.
  collect_snapshot / run_forever          the I/O: the same composition
                                          `/sessions` serves, on a timer.

Rules that are not negotiable:

  - **A herdr outage is not fleet news.** When herdr does not answer, every row
    degrades to `unknown`; diffing that against a healthy snapshot would report
    the whole fleet as having changed. Such a snapshot is discarded whole and
    `prev` is kept, so whatever really happened during the blindness is
    reported once, against real evidence, when herdr comes back.
  - **No message leaves the machine without an explicit opt-in.** The Telegram
    sink does not exist unless a config file says `enabled: true` and names a
    target. Absent config, absent file, unreadable file — no sink.
  - **A sink can never break the watcher.** Sinks are called inside a
    try/except; a failing `hermes send` costs a line on stderr.
  - **The push is an accelerator, never the contract.** `GET /events?after=…`
    stays the feed of record; `EventStream` hands the same numbered events to a
    socket sooner. Both share one cursor, so anything the socket drops the next
    poll picks up.
"""

import asyncio
import json
import os
import queue
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

# The gateway imports the plugin api by path, which does not put this directory
# on sys.path; `python3 watch.py --daemon` needs the same guarantee.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import coms_registry  # noqa: E402
import herdr_source  # noqa: E402
import sessions  # noqa: E402

# A question has to persist this long before it is worth a notification. An
# orchestrator that asks something and answers itself two polls later was never
# news, and a fleet that pings the phone for those stops being read.
HOLD_MS = 20_000

# The same (kind, agent) is not repeated inside this window even if the state
# flaps. Transitions are edge-triggered, so this is the second line of defence.
COLLAPSE_MS = 60_000

# Hard ceiling per rolling minute. A fleet that is genuinely falling over
# produces one `throttled` event saying how much was suppressed, not forty
# toasts.
MAX_PER_MINUTE = 12

# Events kept for `since()`. Bounded, per process, lost on restart — the same
# contract as the dispatch transcript.
BUFFER_SIZE = 200

# How long a stream waits for news before saying something anyway. The frame is
# empty, and it is not for the events: it tells the pane the socket is still the
# live feed, which is the only reason the pane is allowed to slow its poll down.
# A socket that stops speaking therefore degrades to "poll every 5s" on its own,
# without anyone having to detect a broken connection.
STREAM_KEEPALIVE_S = 20.0

# Batches one slow client may fall behind before the stream stops queueing for
# it. Dropping is safe by construction: the poll shares the cursor, so a dropped
# batch arrives late rather than never — which is exactly why the poll stays.
STREAM_QUEUE = 64

# How often the background runner takes its own snapshot. The pane polls at 3s
# while it is visible; this is for when it is not, so it trades latency for a
# quarter of the subprocess cost. `0` disables the thread entirely.
DEFAULT_INTERVAL_S = 15.0

# Where the Telegram opt-in lives. Profile-scoped rather than in the repo,
# because the plugin directory is a symlink INTO the repo on a normal install.
CONFIG_ENV = "AGENT_FLEET_WATCH_CONFIG"
CONFIG_BASENAME = "agent-fleet-watch.json"
INTERVAL_ENV = "AGENT_FLEET_WATCH_INTERVAL"

# What `hermes send --to` and `--profile` may contain, checked before either
# reaches argv. Mirrors HERMES_PROFILE_RE in scripts/coms-hermes-bridge.ts.
_TARGET_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:._-")

NEEDS_ANSWER = "needs_answer"
UNBLOCKED = "unblocked"
FINISHED = "finished"
VANISHED = "vanished"
STALE = "stale"
DISPATCH_ANSWERED = "dispatch_answered"
DISPATCH_FAILED = "dispatch_failed"
THROTTLED = "throttled"

# Only `needs_answer` waits. Everything else describes something already over,
# and holding it back would only make it arrive late.
_HELD_KINDS = (NEEDS_ANSWER,)

# The renderer's words for a dispatch that did not answer (presentation.js),
# repeated here so one vocabulary reaches both the pane and the phone.
_DISPATCH_LABEL = {"error": "refused", "failed": "not delivered", "timeout": "no answer"}

_TERMINAL_DISPATCH = {"answered", "error", "failed", "timeout"}


@dataclass(frozen=True)
class Event:
    """One thing that happened, already in words.

    `seq` is assigned by the buffer, not by the detector: the pure layer has no
    idea how many events came before it, and must not pretend to.
    """

    kind: str
    project: str
    name: str
    message: str
    at: str
    seq: int = 0

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.kind, self.project, self.name)

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "kind": self.kind,
            "project": self.project,
            "name": self.name,
            "message": self.message,
            "at": self.at,
        }


def format_age(seconds) -> str:
    """`45s`, `3m12s`, `2h13m` — the port of formatAge() in presentation.js.

    An unreadable input is the empty string, never `0s`: a caller pasting that
    into a sentence must render nothing rather than make a claim.
    """
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds < 0:
        return ""
    whole = int(seconds)
    if whole < 60:
        return f"{whole}s"
    if whole < 3600:
        return f"{whole // 60}m{whole % 60:02d}s"
    if whole < 86400:
        return f"{whole // 3600}h{(whole % 3600) // 60}m"
    return f"{whole // 86400}d{(whole % 86400) // 3600}h"


def _who(project: str, name: str) -> str:
    return f"{name} · {project}"


def rows_by_key(snapshot: dict | None) -> dict[tuple[str, str], dict]:
    """`(project, name)` -> row, flattened out of the grouped payload."""
    index: dict[tuple[str, str], dict] = {}
    for group in (snapshot or {}).get("projects") or []:
        project = group.get("project") or ""
        for row in group.get("sessions") or []:
            name = row.get("name")
            if name:
                index[(project, name)] = row
    return index


def dispatches_by_id(snapshot: dict | None) -> dict[str, dict]:
    return {
        row["msg_id"]: row
        for row in (snapshot or {}).get("dispatches") or []
        if isinstance(row, dict) and row.get("msg_id")
    }


def is_evidence(snapshot: dict | None) -> bool:
    """Whether this snapshot can be compared with another one at all.

    A payload herdr did not contribute to says nothing about what anyone is
    doing — every row reads `unknown` for one reason that has nothing to do with
    the fleet. Diffing it would announce the entire roster twice: once as it
    goes blind, once as it comes back.
    """
    if not isinstance(snapshot, dict) or snapshot.get("herdr") is not True:
        return False
    return coms_registry.parse_timestamp_ms(snapshot.get("collected_at")) is not None


def diff_snapshots(prev: dict | None, nxt: dict) -> list[Event]:
    """Every transition between two comparable snapshots, in a stable order.

    Pure: the only clock is `nxt["collected_at"]`. The FIRST snapshot produces
    nothing — a fleet that already exists is not news, and reporting it would
    make every gateway restart announce the whole roster.
    """
    at = str(nxt.get("collected_at") or "")
    if prev is None:
        return []

    before = rows_by_key(prev)
    after = rows_by_key(nxt)
    events: list[Event] = []

    for key in sorted(before):
        project, name = key
        old = before[key]
        new = after.get(key)

        if new is None:
            # Gone from the registry means the process is gone: `entry_is_live`
            # probes the pid. Whether that is good news depends entirely on what
            # it was doing when we last looked.
            uptime = format_age(old.get("uptime_s"))
            after_clause = f" after {uptime}" if uptime else ""
            if old.get("state") == "working":
                events.append(
                    Event(VANISHED, project, name, f"{_who(project, name)} vanished while working{after_clause}", at)
                )
            else:
                events.append(Event(FINISHED, project, name, f"{_who(project, name)} ended{after_clause}", at))
            continue

        was_blocked = bool(old.get("needs_answer"))
        is_blocked = bool(new.get("needs_answer"))
        if is_blocked and not was_blocked:
            events.append(Event(NEEDS_ANSWER, project, name, f"{_who(project, name)} needs an answer", at))
        elif was_blocked and not is_blocked:
            events.append(Event(UNBLOCKED, project, name, f"{_who(project, name)} is no longer waiting", at))

        if new.get("stale") and not old.get("stale"):
            age = format_age(new.get("heartbeat_age_s"))
            for_clause = f" for {age}" if age else ""
            events.append(
                Event(STALE, project, name, f"{_who(project, name)} has not heartbeat{for_clause}", at)
            )

    old_dispatches = dispatches_by_id(prev)
    for msg_id, dispatch in sorted(dispatches_by_id(nxt).items()):
        status = dispatch.get("status")
        was = (old_dispatches.get(msg_id) or {}).get("status")
        # Only the crossing into a terminal state. A dispatch that is already
        # answered when we first see it was answered before we were watching.
        if status not in _TERMINAL_DISPATCH or was == status or msg_id not in old_dispatches:
            continue
        project = dispatch.get("project") or ""
        name = dispatch.get("name") or ""
        if status == "answered":
            events.append(Event(DISPATCH_ANSWERED, project, name, f"{_who(project, name)} answered", at))
        else:
            reason = dispatch.get("detail") or _DISPATCH_LABEL.get(status, status)
            events.append(Event(DISPATCH_FAILED, project, name, f"{_who(project, name)}: {reason}", at))

    return events


@dataclass
class _Held:
    event: Event
    since_ms: float


@dataclass
class Watcher:
    """The memory around `diff_snapshots`: debounce, collapse, cap, buffer.

    Thread-safe because two things feed it — the `/sessions` request handler and
    the background runner — and one thing drains it.
    """

    hold_ms: float = HOLD_MS
    collapse_ms: float = COLLAPSE_MS
    max_per_minute: int = MAX_PER_MINUTE
    capacity: int = BUFFER_SIZE
    sinks: list = field(default_factory=list)

    def __post_init__(self):
        self._lock = threading.RLock()
        self._prev: dict | None = None
        self._held: dict[tuple[str, str], _Held] = {}
        self._emitted: dict[tuple[str, str, str], float] = {}
        self._window: deque[float] = deque()
        self._throttled_at: float | None = None
        self._buffer: deque[Event] = deque(maxlen=self.capacity)
        self._seq = 0
        # Outbound work never runs on the thread that observed. `hermes send`
        # is a subprocess with a timeout, and a `/sessions` request must not
        # wait on it — nor hold the lock the pane's next poll needs.
        self._outbox: queue.Queue = queue.Queue(maxsize=200)
        self._sender: threading.Thread | None = None
        # Live listeners (one per open WebSocket). Separate from `sinks`: a sink
        # is a channel out of the machine and runs on its own thread, a
        # subscriber is a client already waiting and is handed the batch
        # directly.
        self._subscribers: list = []
        # Monotone: snapshots from two feeders can arrive out of order, and time
        # running backwards would release a hold early or reopen the cap.
        self._clock = 0.0

    # ── the in ─────────────────────────────────────────────────────────────

    def observe(self, snapshot: dict) -> list[Event]:
        """Fold one snapshot in and return whatever became news because of it."""
        if not is_evidence(snapshot):
            return []

        with self._lock:
            now_ms = max(self._clock, coms_registry.parse_timestamp_ms(snapshot.get("collected_at")) or 0.0)
            self._clock = now_ms
            raw = diff_snapshots(self._prev, snapshot)
            self._prev = snapshot

            ready: list[Event] = []
            for event in raw:
                key = (event.project, event.name)
                if event.kind in _HELD_KINDS:
                    self._held.setdefault(key, _Held(event, now_ms))
                elif event.kind == UNBLOCKED and key in self._held:
                    # Answered inside the debounce. We never said it was
                    # waiting, so saying it has stopped is noise about nothing.
                    del self._held[key]
                else:
                    ready.append(event)

            ready.extend(self._release_held(snapshot, now_ms))
            numbered = self._emit(ready, now_ms)

        # Outside the lock on purpose — see `_outbox`.
        if numbered:
            self._forward(numbered)
            self._publish(numbered)
        return numbered

    def _release_held(self, snapshot: dict, now_ms: float) -> list[Event]:
        """Questions that outlived the debounce, and the ones that never will.

        A row that stopped waiting before the hold expired is dropped in
        silence: it was answered inside 20 seconds, so there is nothing to tell
        anyone, and — since no `needs_answer` was ever sent — no `unblocked`
        either. That pairing is the whole point of holding it here rather than
        filtering on the way out.
        """
        rows = rows_by_key(snapshot)
        released: list[Event] = []
        for key, held in list(self._held.items()):
            row = rows.get(key)
            if row is None or not row.get("needs_answer"):
                del self._held[key]
                continue
            if now_ms - held.since_ms >= self.hold_ms:
                del self._held[key]
                # Re-stamped: the event is dated when it is told, not when the
                # question first appeared — the message says "needs an answer",
                # present tense, and it is true at this snapshot.
                released.append(replace(held.event, at=str(snapshot.get("collected_at") or held.event.at)))
        return released

    def _emit(self, events: list[Event], now_ms: float) -> list[Event]:
        """Collapse, cap, number, buffer. Called under the lock."""
        kept: list[Event] = []
        for event in events:
            last = self._emitted.get(event.key)
            if last is not None and now_ms - last < self.collapse_ms:
                continue
            self._emitted[event.key] = now_ms
            kept.append(event)

        # The ledger only matters inside the collapse window; keeping a row for
        # every agent that ever existed would be a slow leak in a long-lived
        # gateway.
        self._emitted = {key: at for key, at in self._emitted.items() if now_ms - at < self.collapse_ms}

        while self._window and now_ms - self._window[0] > 60_000:
            self._window.popleft()

        allowed = max(0, self.max_per_minute - len(self._window))
        suppressed = max(0, len(kept) - allowed)
        kept = kept[:allowed]
        if suppressed > 0:
            # One line about the flood rather than the flood. Repeated at most
            # once a minute, so a fleet stuck in a loop cannot escalate through
            # its own throttle notice.
            if self._throttled_at is None or now_ms - self._throttled_at >= 60_000:
                self._throttled_at = now_ms
                kept.append(
                    Event(
                        THROTTLED,
                        "",
                        "",
                        f"{suppressed} more fleet events suppressed this minute",
                        datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                    )
                )

        numbered: list[Event] = []
        for event in kept:
            self._seq += 1
            self._window.append(now_ms)
            stamped = replace(event, seq=self._seq)
            self._buffer.append(stamped)
            numbered.append(stamped)

        return numbered

    def _forward(self, events: list[Event]) -> None:
        """Hand the batch to the sender thread; never block the caller.

        A full outbox means the sinks are slower than the fleet is eventful. The
        batch is dropped with a line on stderr rather than queued forever: these
        are notifications about a live fleet, and a message about a question
        somebody answered ten minutes ago is worse than no message.
        """
        if not self.sinks:
            return
        self._ensure_sender()
        try:
            self._outbox.put_nowait(events)
        except queue.Full:
            print(f"agent-fleet-herdr: watch outbox full, dropped {len(events)} events", file=sys.stderr)

    def _ensure_sender(self) -> None:
        with self._lock:
            if self._sender is not None and self._sender.is_alive():
                return
            self._sender = threading.Thread(target=self._drain, name="agent-fleet-watch-send", daemon=True)
            self._sender.start()

    def _drain(self) -> None:
        while True:
            events = self._outbox.get()
            try:
                for sink in self.sinks:
                    try:
                        sink(events)
                    except Exception as error:  # a sink is never allowed to stop the watcher
                        print(f"agent-fleet-herdr: watch sink failed: {error}", file=sys.stderr)
            finally:
                self._outbox.task_done()

    def flush(self) -> None:
        """Block until the outbox is empty. For tests and for `--once`."""
        self._outbox.join()

    # ── the out ────────────────────────────────────────────────────────────

    def since(self, after: int = 0) -> dict:
        """Everything numbered above `after`, plus where the sequence now is.

        `seq` is returned even when the list is empty, so a client that has been
        away longer than the buffer resumes from the present instead of
        replaying whatever survived.
        """
        with self._lock:
            events = [event for event in self._buffer if event.seq > after]
            return {"events": [event.as_dict() for event in events], "seq": self._seq}

    def subscribe(self, callback):
        """Be told, instead of asking. Returns the unsubscribe.

        `callback(events)` runs on whichever thread observed the snapshot — a
        `/sessions` request handler or the background runner — so a subscriber
        must not block and must not raise. `EventStream`, the only one that
        matters, does nothing but hand the batch to an event loop.

        This does not replace `since()`: a subscriber is only told what happens
        while it is subscribed, and the buffer is what covers the gap around
        that. Both are used together, in that order.
        """
        with self._lock:
            self._subscribers.append(callback)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return unsubscribe

    def _publish(self, events: list[Event]) -> None:
        """Fan a batch out to the live listeners. Called outside the lock.

        Same rule as the sinks, for the same reason: a listener that raises is
        a client with a problem, not a fleet with one.
        """
        with self._lock:
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(events)
            except Exception as error:  # a listener is never allowed to stop the watcher
                print(f"agent-fleet-herdr: watch subscriber failed: {error}", file=sys.stderr)


class EventStream:
    """One WebSocket's view of the watcher: the backlog it missed, then live.

    Subscribe first, read the backlog second. The other order has a hole in it —
    an event landing between the two would be in neither — and this order can
    only produce a duplicate, which is the failure worth having: every frame is
    filtered against the cursor, so a repeat dies here instead of becoming a
    second toast.

    The cursor is the same number `GET /events?after=` takes, on purpose. The
    two feeds are interchangeable, which is what makes the poll a real fallback
    rather than a second implementation of the same idea.
    """

    def __init__(self, watcher: Watcher, after: int = 0, loop=None, maxsize: int = STREAM_QUEUE):
        self._watcher = watcher
        self._seq = max(0, int(after or 0))
        # Captured at construction, on the thread that will consume the frames:
        # events arrive on somebody else's thread and have to be handed over.
        self._loop = loop or asyncio.get_running_loop()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._unsubscribe = watcher.subscribe(self._offer)

    def _offer(self, events: list[Event]) -> None:
        """Called by the watcher, on the watcher's thread. Must not block."""
        try:
            self._loop.call_soon_threadsafe(self._enqueue, events)
        except RuntimeError:
            # The loop is closed — this connection is already gone and the
            # unsubscribe is racing us. Nothing to report.
            pass

    def _enqueue(self, events: list[Event]) -> None:
        try:
            self._queue.put_nowait(events)
        except asyncio.QueueFull:
            # See STREAM_QUEUE: the poll shares this cursor, so the client gets
            # these events late rather than not at all.
            print(
                f"agent-fleet-herdr: event stream is behind, dropped {len(events)} events",
                file=sys.stderr,
            )

    def backlog(self) -> dict:
        """Whatever the buffer holds past the cursor — the first frame sent."""
        payload = self._watcher.since(self._seq)
        return self._frame(payload.get("events") or [], payload.get("seq"))

    async def next_frame(self, timeout: float = STREAM_KEEPALIVE_S) -> dict:
        """The next batch, or an empty keepalive once `timeout` passes."""
        try:
            events = await asyncio.wait_for(self._queue.get(), timeout)
        except asyncio.TimeoutError:
            return {"events": [], "seq": self._seq, "keepalive": True}
        return self._frame(events)

    def _frame(self, events, seq=None) -> dict:
        """Serialize, drop anything at or behind the cursor, advance it.

        Takes `Event`s (from the subscription) or dicts (from the buffer)
        because both feed the same connection.
        """
        rows = [event.as_dict() if isinstance(event, Event) else dict(event) for event in events]
        fresh = [row for row in rows if _row_seq(row) > self._seq]
        self._seq = max([self._seq, int(seq or 0), *[_row_seq(row) for row in fresh]])
        return {"events": fresh, "seq": self._seq}

    def close(self) -> None:
        self._unsubscribe()


def _row_seq(row: dict) -> int:
    try:
        return int(row.get("seq") or 0)
    except (TypeError, ValueError):
        return 0


# ── the I/O side ───────────────────────────────────────────────────────────


def collect_snapshot(dispatcher=None) -> dict:
    """The `/sessions` payload — the one composition, used by both feeders.

    Raises `coms_registry.RegistryUnavailable` when the registry itself cannot
    be read; a herdr that does not answer is a normal payload with `herdr:
    false`, exactly as the endpoint promises.
    """
    projects = coms_registry.live_sessions_by_project()
    try:
        panes, pane_total = herdr_source.pane_snapshot()
    except herdr_source.HerdrUnavailable:
        panes, pane_total = None, None
    payload = sessions.build_sessions(projects, panes, pane_total=pane_total)
    if dispatcher is not None:
        payload["dispatches"] = dispatcher.recent()
    return payload


def config_path() -> Path:
    override = os.environ.get(CONFIG_ENV)
    if override:
        return Path(override).expanduser()
    return Path(os.environ.get("HERMES_HOME") or "~/.hermes").expanduser() / CONFIG_BASENAME


def _safe_token(value) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 64:
        return None
    return value if set(value) <= _TARGET_CHARS else None


def load_config(path: Path | None = None) -> dict:
    """The opt-in, or `{}`.

    Every failure — no file, bad JSON, unreadable — is the same answer: there is
    no configuration, so there is no outbound sink. A notification channel that
    turns itself on because a file half-parsed is not a channel anyone should
    trust.
    """
    path = path if path is not None else config_path()
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


class HermesSink:
    """`hermes send --to <target>` for each event, one subprocess at a time.

    Spawned exactly as scripts/coms-hermes-bridge.ts spawns it — no shell, and
    the target and profile are validated against a character class before they
    reach argv, because both come out of a config file.
    """

    def __init__(self, target: str, profile: str | None = None, kinds=None, timeout_s: float = 20.0, runner=None):
        self.target = target
        self.profile = profile
        # `None` means every kind. An explicit list is the way to get only the
        # two that wake a phone at night.
        self.kinds = set(kinds) if kinds else None
        self.timeout_s = timeout_s
        self._run = runner or subprocess.run

    def __call__(self, events) -> None:
        for event in events:
            if self.kinds is not None and event.kind not in self.kinds:
                continue
            args = ["hermes"]
            if self.profile:
                args += ["--profile", self.profile]
            args += ["send", "--to", self.target, event.message]
            try:
                result = self._run(args, capture_output=True, text=True, timeout=self.timeout_s, check=False)
            except (OSError, subprocess.SubprocessError) as error:
                print(f"agent-fleet-herdr: hermes send failed: {error}", file=sys.stderr)
                continue
            if getattr(result, "returncode", 1) != 0:
                detail = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "").strip()
                print(f"agent-fleet-herdr: hermes send failed: {detail}", file=sys.stderr)


def build_sink(config: dict):
    """The Telegram sink, or `None` — which is what an absent opt-in means.

    Three separate things must be true and are checked separately, so a
    half-written config is off rather than aimed somewhere unintended:
    `telegram.enabled is True`, a target that survives validation, and — if
    given — a profile that does too.
    """
    telegram = config.get("telegram")
    if not isinstance(telegram, dict) or telegram.get("enabled") is not True:
        return None
    target = _safe_token(telegram.get("target"))
    if target is None:
        print("agent-fleet-herdr: watch config has telegram.enabled but no usable target", file=sys.stderr)
        return None
    profile = telegram.get("profile")
    if profile is not None and _safe_token(profile) is None:
        print("agent-fleet-herdr: watch config has an unusable telegram.profile", file=sys.stderr)
        return None
    kinds = telegram.get("kinds")
    return HermesSink(target, profile=profile, kinds=kinds if isinstance(kinds, list) else None)


def build_watcher(config: dict | None = None) -> Watcher:
    config = load_config() if config is None else config
    sink = build_sink(config)
    return Watcher(sinks=[sink] if sink else [])


def interval_from(config: dict) -> float:
    """Seconds between the runner's own snapshots; `0` means no runner.

    The environment wins over the file so the background thread can be switched
    off for one process — a test run, a second gateway — without editing a
    config that another process is reading.
    """
    override = os.environ.get(INTERVAL_ENV)
    if override is not None:
        try:
            return max(0.0, float(override))
        except ValueError:
            print(f"agent-fleet-herdr: {INTERVAL_ENV}={override!r} is not a number", file=sys.stderr)
    value = config.get("interval_s", DEFAULT_INTERVAL_S)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return DEFAULT_INTERVAL_S
    return float(value)


def run_forever(watcher: Watcher, interval_s: float, dispatcher=None, stop: threading.Event | None = None) -> None:
    """Snapshot on a timer until told to stop. Survives every source failing.

    The loop is what makes the pane optional: the request handler only feeds the
    watcher while someone is polling, and the whole point of this phase is to
    learn about a stuck agent when nobody is looking.
    """
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            watcher.observe(collect_snapshot(dispatcher))
        except Exception as error:  # a bad snapshot must not end the thread
            print(f"agent-fleet-herdr: watch poll failed: {error}", file=sys.stderr)
        stop.wait(interval_s)


_runner_lock = threading.Lock()
_runner: threading.Thread | None = None


def ensure_runner(watcher: Watcher, interval_s: float, dispatcher=None) -> threading.Thread | None:
    """Start the background loop once, on first use. Idempotent by design.

    Lazy rather than at import: the gateway constructs its routers whether or
    not anyone opens the pane, and a plugin nobody uses should not be running
    `herdr agent list` in a loop.
    """
    global _runner
    if interval_s <= 0:
        return None
    with _runner_lock:
        if _runner is not None and _runner.is_alive():
            return _runner
        _runner = threading.Thread(
            target=run_forever,
            args=(watcher, interval_s, dispatcher),
            name="agent-fleet-watch",
            daemon=True,
        )
        _runner.start()
        return _runner


def main(argv: list[str] | None = None) -> int:
    """`python3 watch.py --daemon` — the watcher without a Desktop window.

    The in-gateway runner dies with the process that hosts it, and the Desktop's
    own gateway dies with the Desktop app. Anything that has to reach a phone
    while nothing is open belongs here, under systemd or a terminal.
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    config = load_config()
    interval = interval_from(config)
    if "--interval" in argv:
        try:
            interval = float(argv[argv.index("--interval") + 1])
        except (IndexError, ValueError):
            print("--interval wants a number of seconds", file=sys.stderr)
            return 2

    watcher = build_watcher(config)
    if not watcher.sinks and "--daemon" in argv:
        print(
            f"agent-fleet-herdr: no outbound sink configured ({config_path()}); "
            "the daemon will detect events and send nothing",
            file=sys.stderr,
        )

    # There is nothing to report from a single snapshot — the first one is never
    # news — so the one-shot mode prints what the watcher SEES. That is the
    # question worth asking a live gateway: is the payload the one I expect?
    if "--snapshot" in argv:
        print(json.dumps(collect_snapshot(), indent=2))
        return 0

    if "--daemon" not in argv:
        print(__doc__)
        print("usage: watch.py --daemon [--interval SECONDS] | --snapshot", file=sys.stderr)
        return 2

    interval = interval or DEFAULT_INTERVAL_S
    print(f"agent-fleet-herdr: watching every {interval:g}s", file=sys.stderr)
    try:
        run_forever(watcher, interval)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
