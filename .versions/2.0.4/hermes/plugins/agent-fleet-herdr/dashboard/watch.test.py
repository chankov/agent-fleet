"""Slice 5 — the watcher: what counts as news, and what does not.

Every case is a pair of hand-written snapshots, because that is exactly what the
detector consumes. No clock, no sockets, no herdr.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/watch.test.py
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import watch  # noqa: E402


def row(name, state="idle", **extra):
    return {
        "name": name,
        "state": state,
        "needs_answer": state == "blocked",
        "model": "minimax-m3:cloud",
        "stale": False,
        "uptime_s": 840,
        "heartbeat_age_s": 3,
        **extra,
    }


def snap(rows, at="2026-07-27T10:00:00Z", herdr=True, project="alpha", dispatches=None):
    """One `/sessions` payload. `rows` may be a list (one project) or a dict."""
    grouped = rows if isinstance(rows, dict) else {project: rows}
    return {
        "projects": [{"project": name, "sessions": items} for name, items in grouped.items()],
        "herdr": herdr,
        "herdr_panes": 3 if herdr else None,
        "collected_at": at,
        "dispatches": dispatches or [],
    }


def at(seconds: int) -> str:
    """A collected_at `seconds` after the fixtures' baseline."""
    return f"2026-07-27T10:{seconds // 60:02d}:{seconds % 60:02d}Z"


def kinds(events):
    return [event.kind for event in events]


class Ran:
    """What `subprocess.run` gives back when the send worked."""

    returncode = 0
    stderr = ""
    stdout = ""


class DiffTest(unittest.TestCase):
    def test_an_unchanged_snapshot_is_not_news(self):
        before = snap([row("orchestrator", "working")])
        after = snap([row("orchestrator", "working")], at=at(3))
        self.assertEqual(diff := watch.diff_snapshots(before, after), [], f"got {kinds(diff)}")

    def test_the_first_snapshot_announces_nothing(self):
        # Otherwise every gateway restart reports the entire fleet as new.
        self.assertEqual(watch.diff_snapshots(None, snap([row("a"), row("b", "blocked")])), [])

    def test_one_event_per_transition_and_no_repeats(self):
        idle = snap([row("orchestrator", "idle")])
        blocked = snap([row("orchestrator", "blocked")], at=at(3))
        still = snap([row("orchestrator", "blocked")], at=at(6))
        free = snap([row("orchestrator", "working")], at=at(9))

        self.assertEqual(kinds(watch.diff_snapshots(idle, blocked)), ["needs_answer"])
        self.assertEqual(kinds(watch.diff_snapshots(blocked, still)), [], "still waiting is not a new event")
        self.assertEqual(kinds(watch.diff_snapshots(still, free)), ["unblocked"])

    def test_gone_while_working_and_gone_after_idling_are_different_words(self):
        working = snap([row("orchestrator", "working", uptime_s=840)])
        idle = snap([row("orchestrator", "idle", uptime_s=840)])
        empty = snap([], at=at(3))

        [vanished] = watch.diff_snapshots(working, empty)
        self.assertEqual(vanished.kind, "vanished")
        self.assertIn("14m00s", vanished.message, "how long it ran is the first thing you want")

        [finished] = watch.diff_snapshots(idle, empty)
        self.assertEqual(finished.kind, "finished")
        self.assertEqual((finished.project, finished.name), ("alpha", "orchestrator"))

    def test_a_stopped_heartbeat_is_reported_once(self):
        alive = snap([row("orchestrator", "working")])
        stopped = snap([row("orchestrator", "working", stale=True, heartbeat_age_s=240)], at=at(3))
        again = snap([row("orchestrator", "working", stale=True, heartbeat_age_s=300)], at=at(6))

        [event] = watch.diff_snapshots(alive, stopped)
        self.assertEqual(event.kind, "stale")
        self.assertIn("4m00s", event.message)
        self.assertEqual(watch.diff_snapshots(stopped, again), [])

    def test_the_pair_is_the_key_so_two_projects_do_not_merge(self):
        before = snap({"alpha": [row("orchestrator", "idle")], "zulu": [row("orchestrator", "idle")]})
        after = snap({"alpha": [row("orchestrator", "blocked")], "zulu": [row("orchestrator", "idle")]}, at=at(3))

        [event] = watch.diff_snapshots(before, after)
        self.assertEqual((event.project, event.name), ("alpha", "orchestrator"))

    def test_a_dispatch_reaching_a_terminal_state_is_news_exactly_once(self):
        pending = {"msg_id": "M1", "project": "alpha", "name": "reviewer", "status": "pending"}
        before = snap([row("reviewer")], dispatches=[pending])
        answered = snap([row("reviewer")], at=at(3), dispatches=[{**pending, "status": "answered"}])
        again = snap([row("reviewer")], at=at(6), dispatches=[{**pending, "status": "answered"}])

        self.assertEqual(kinds(watch.diff_snapshots(before, answered)), ["dispatch_answered"])
        self.assertEqual(watch.diff_snapshots(answered, again), [])

        failed = snap([row("reviewer")], at=at(3), dispatches=[{**pending, "status": "failed", "detail": "peer is not listening"}])
        [event] = watch.diff_snapshots(before, failed)
        self.assertEqual(event.kind, "dispatch_failed")
        self.assertIn("peer is not listening", event.message)

    def test_a_dispatch_that_was_already_over_when_we_arrived_is_not_news(self):
        before = snap([row("reviewer")])
        after = snap([row("reviewer")], at=at(3), dispatches=[{"msg_id": "M9", "project": "a", "name": "b", "status": "answered"}])
        self.assertEqual(watch.diff_snapshots(before, after), [])


class OutageTest(unittest.TestCase):
    """A herdr that stops answering is not something the fleet did."""

    def test_a_herdr_outage_produces_no_events_at_all(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("orchestrator", "working"), row("reviewer", "blocked")]))

        blind = snap(
            [row("orchestrator", "unknown"), row("reviewer", "unknown")],
            at=at(3),
            herdr=False,
        )
        self.assertEqual(watcher.observe(blind), [], "every row going unknown is one outage, not two events")

    def test_what_really_happened_is_reported_when_herdr_comes_back(self):
        # `prev` is kept across the blindness, so recovery diffs against the
        # last snapshot anyone could actually believe.
        watcher = watch.Watcher()
        watcher.observe(snap([row("orchestrator", "working")]))
        watcher.observe(snap([row("orchestrator", "unknown")], at=at(3), herdr=False))
        events = watcher.observe(snap([], at=at(6)))
        self.assertEqual(kinds(events), ["vanished"])

    def test_a_payload_with_an_unreadable_timestamp_is_not_evidence(self):
        self.assertFalse(watch.is_evidence(snap([row("a")], at="not-a-date")))
        self.assertFalse(watch.is_evidence(None))
        self.assertTrue(watch.is_evidence(snap([row("a")])))


class DebounceTest(unittest.TestCase):
    def test_a_question_must_persist_before_it_interrupts_anyone(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("reviewer", "idle")]))

        self.assertEqual(watcher.observe(snap([row("reviewer", "blocked")], at=at(3))), [])
        self.assertEqual(watcher.observe(snap([row("reviewer", "blocked")], at=at(10))), [], "10s in is still too soon")

        [event] = watcher.observe(snap([row("reviewer", "blocked")], at=at(30)))
        self.assertEqual(event.kind, "needs_answer")
        self.assertEqual(event.at, at(30), "the event is dated when it is told, not when it was first seen")

    def test_a_question_answered_inside_the_debounce_is_never_mentioned(self):
        # And crucially: no `unblocked` either. Announcing the end of something
        # nobody was told about is the noise this whole layer exists to avoid.
        watcher = watch.Watcher()
        watcher.observe(snap([row("reviewer", "idle")]))
        watcher.observe(snap([row("reviewer", "blocked")], at=at(3)))
        self.assertEqual(watcher.observe(snap([row("reviewer", "working")], at=at(9))), [])
        self.assertEqual(watcher.observe(snap([row("reviewer", "working")], at=at(60))), [])

    def test_a_session_that_dies_while_still_waiting_reports_the_death(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("reviewer", "idle")]))
        watcher.observe(snap([row("reviewer", "blocked")], at=at(3)))
        self.assertEqual(kinds(watcher.observe(snap([], at=at(9)))), ["finished"])

    def test_the_same_transition_does_not_repeat_inside_the_collapse_window(self):
        watcher = watch.Watcher(hold_ms=0)
        watcher.observe(snap([row("reviewer", "idle")]))
        first = watcher.observe(snap([row("reviewer", "blocked")], at=at(3)))
        watcher.observe(snap([row("reviewer", "idle")], at=at(6)))
        second = watcher.observe(snap([row("reviewer", "blocked")], at=at(9)))

        self.assertEqual(kinds(first), ["needs_answer"])
        self.assertEqual(second, [], "flapping inside a minute is one piece of news")


class FloodTest(unittest.TestCase):
    def test_a_fleet_falling_over_produces_one_line_about_the_flood(self):
        watcher = watch.Watcher(hold_ms=0, max_per_minute=3)
        names = [f"agent{index}" for index in range(10)]
        watcher.observe(snap([row(name, "idle") for name in names]))
        events = watcher.observe(snap([row(name, "blocked") for name in names], at=at(3)))

        self.assertEqual(len(events), 4, "three real events plus the notice about the rest")
        self.assertEqual(kinds(events)[-1], "throttled")
        self.assertIn("7 more", events[-1].message)

    def test_the_throttle_notice_cannot_escalate_through_its_own_throttle(self):
        watcher = watch.Watcher(hold_ms=0, collapse_ms=0, max_per_minute=1)
        watcher.observe(snap([row(f"agent{index}", "idle") for index in range(5)]))
        watcher.observe(snap([row(f"agent{index}", "blocked") for index in range(5)], at=at(3)))
        again = watcher.observe(snap([row(f"agent{index}", "idle") for index in range(5)], at=at(6)))
        self.assertNotIn("throttled", kinds(again), "one flood notice a minute is enough")


class BufferTest(unittest.TestCase):
    def test_the_cursor_hands_each_event_out_once(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))

        first = watcher.since(0)
        self.assertEqual([event["kind"] for event in first["events"]], ["vanished"])
        self.assertEqual(first["seq"], 1)
        self.assertEqual(watcher.since(first["seq"])["events"], [])

    def test_a_client_further_behind_than_the_buffer_resumes_from_the_present(self):
        watcher = watch.Watcher(hold_ms=0, capacity=2, max_per_minute=100, collapse_ms=0)
        for index in range(4):
            watcher.observe(snap([row("a", "idle")], at=at(index * 2)))
            watcher.observe(snap([row("a", "blocked")], at=at(index * 2 + 1)))

        payload = watcher.since(0)
        self.assertEqual(len(payload["events"]), 2, "the buffer is bounded")
        # Seven transitions: the first snapshot of the eight is the baseline.
        self.assertEqual(payload["seq"], 7, "seq is the truth even when the events are gone")

    def test_events_serialise_to_what_the_pane_reads(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))
        [event] = watcher.since(0)["events"]
        self.assertEqual(sorted(event), ["at", "kind", "message", "name", "project", "seq"])


class SinkTest(unittest.TestCase):
    def test_nothing_leaves_the_machine_without_an_explicit_opt_in(self):
        for config in (
            {},
            {"telegram": {}},
            {"telegram": {"target": "telegram"}},
            {"telegram": {"enabled": False, "target": "telegram"}},
            {"telegram": {"enabled": "yes", "target": "telegram"}},
            {"telegram": {"enabled": True}},
        ):
            self.assertIsNone(watch.build_sink(config), f"{config} must not produce a sink")

    def test_an_unusable_target_or_profile_is_refused_rather_than_guessed(self):
        self.assertIsNone(watch.build_sink({"telegram": {"enabled": True, "target": "telegram; rm -rf /"}}))
        self.assertIsNone(watch.build_sink({"telegram": {"enabled": True, "target": "telegram", "profile": "../evil"}}))
        self.assertIsNotNone(watch.build_sink({"telegram": {"enabled": True, "target": "telegram:1234567"}}))

    def test_an_absent_or_broken_config_file_is_simply_no_config(self):
        missing = Path(__file__).parent / "does-not-exist.json"
        self.assertEqual(watch.load_config(missing), {})
        self.assertEqual(watch.load_config(Path(__file__)), {}, "a python file is not a config")

    def test_the_send_is_argv_never_a_shell_line(self):
        calls = []
        sink = watch.HermesSink("telegram", profile="dev", runner=lambda args, **kw: calls.append(args) or Ran())
        sink([watch.Event("needs_answer", "alpha", "reviewer", "reviewer · alpha needs an answer", at(0))])
        self.assertEqual(
            calls,
            [["hermes", "--profile", "dev", "send", "--to", "telegram", "reviewer · alpha needs an answer"]],
        )

    def test_a_kind_filter_keeps_the_phone_for_what_matters(self):
        calls = []
        sink = watch.HermesSink("telegram", kinds=["needs_answer"], runner=lambda args, **kw: calls.append(args) or Ran())
        sink(
            [
                watch.Event("finished", "alpha", "a", "a ended", at(0)),
                watch.Event("needs_answer", "alpha", "b", "b needs an answer", at(0)),
            ]
        )
        self.assertEqual([args[-1] for args in calls], ["b needs an answer"])

    def test_a_failing_sink_never_stops_the_watcher(self):
        def explode(_events):
            raise RuntimeError("hermes is not installed")

        watcher = watch.Watcher(sinks=[explode])
        watcher.observe(snap([row("a", "working")]))
        events = watcher.observe(snap([], at=at(3)))
        watcher.flush()
        self.assertEqual(kinds(events), ["vanished"], "the buffer is served regardless of the phone")

    def test_events_reach_a_configured_sink(self):
        seen = []
        watcher = watch.Watcher(sinks=[seen.extend])
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))
        watcher.flush()
        self.assertEqual(kinds(seen), ["vanished"])


class SubscriberTest(unittest.TestCase):
    """The push side of the buffer. Same events, same numbers, sooner."""

    def test_a_subscriber_is_told_what_the_buffer_would_have_handed_out(self):
        watcher = watch.Watcher()
        seen = []
        watcher.subscribe(seen.append)
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))

        self.assertEqual([kinds(batch) for batch in seen], [["vanished"]])
        # And the buffer still holds it: a subscriber is an accelerator, never a
        # consumer. The poll has to find the same event.
        self.assertEqual([event["kind"] for event in watcher.since(0)["events"]], ["vanished"])

    def test_an_unsubscribed_listener_hears_nothing_more(self):
        watcher = watch.Watcher(collapse_ms=0)
        seen = []
        unsubscribe = watcher.subscribe(seen.append)
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))
        unsubscribe()
        watcher.observe(snap([row("b", "working")], at=at(6)))
        watcher.observe(snap([], at=at(9)))

        self.assertEqual(len(seen), 1)
        unsubscribe()  # idempotent: a socket that closes twice is not an error

    def test_a_failing_subscriber_never_stops_the_watcher(self):
        watcher = watch.Watcher()
        seen = []

        def explode(_events):
            raise RuntimeError("this client is broken")

        watcher.subscribe(explode)
        watcher.subscribe(seen.append)
        with patch("sys.stderr"):
            watcher.observe(snap([row("a", "working")]))
            events = watcher.observe(snap([], at=at(3)))

        self.assertEqual(kinds(events), ["vanished"])
        self.assertEqual([kinds(batch) for batch in seen], [["vanished"]])

    def test_nothing_at_all_is_published_when_nothing_happened(self):
        watcher = watch.Watcher()
        seen = []
        watcher.subscribe(seen.append)
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([row("a", "working")], at=at(3)))
        self.assertEqual(seen, [])


class EventStreamTest(unittest.IsolatedAsyncioTestCase):
    """One socket's view: the backlog it missed, then frames, never both."""

    async def test_the_backlog_carries_what_happened_before_the_socket_opened(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))

        stream = watch.EventStream(watcher)
        try:
            frame = stream.backlog()
        finally:
            stream.close()
        self.assertEqual([event["kind"] for event in frame["events"]], ["vanished"])
        self.assertEqual(frame["seq"], 1)

    async def test_a_client_that_names_its_cursor_is_not_told_twice(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))

        stream = watch.EventStream(watcher, after=1)
        try:
            self.assertEqual(stream.backlog(), {"events": [], "seq": 1})
        finally:
            stream.close()

    async def test_an_event_in_both_the_backlog_and_the_subscription_is_sent_once(self):
        """The subscription is taken first on purpose — it can duplicate, and
        the alternative order can LOSE. This is the duplicate being caught."""
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))

        stream = watch.EventStream(watcher)
        try:
            watcher.observe(snap([], at=at(3)))  # published AND buffered
            backlog = stream.backlog()
            self.assertEqual([event["kind"] for event in backlog["events"]], ["vanished"])
            frame = await stream.next_frame(timeout=0.05)
        finally:
            stream.close()
        self.assertEqual(frame["events"], [], "the push repeated what the backlog already carried")

    async def test_an_event_that_happens_while_connected_arrives_as_a_frame(self):
        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))

        stream = watch.EventStream(watcher)
        try:
            stream.backlog()
            watcher.observe(snap([], at=at(3)))
            frame = await stream.next_frame(timeout=1.0)
        finally:
            stream.close()
        self.assertEqual([event["kind"] for event in frame["events"]], ["vanished"])
        self.assertEqual(frame["seq"], 1)
        self.assertNotIn("keepalive", frame)

    async def test_silence_becomes_a_keepalive_rather_than_a_dead_connection(self):
        """The frame is empty; what it carries is that the socket still works —
        which is the only reason the pane is allowed to slow its poll down."""
        watcher = watch.Watcher()
        stream = watch.EventStream(watcher, after=4)
        try:
            frame = await stream.next_frame(timeout=0.01)
        finally:
            stream.close()
        self.assertEqual(frame, {"events": [], "seq": 4, "keepalive": True})

    async def test_a_batch_produced_on_another_thread_reaches_the_loop(self):
        """The real shape: the background runner observes on its own thread and
        the socket consumes on the event loop."""
        import threading

        watcher = watch.Watcher()
        watcher.observe(snap([row("a", "working")]))
        stream = watch.EventStream(watcher)
        try:
            stream.backlog()
            thread = threading.Thread(target=lambda: watcher.observe(snap([], at=at(3))))
            thread.start()
            thread.join()
            frame = await stream.next_frame(timeout=1.0)
        finally:
            stream.close()
        self.assertEqual([event["kind"] for event in frame["events"]], ["vanished"])

    async def test_a_client_that_falls_behind_loses_frames_not_the_gateway(self):
        watcher = watch.Watcher(hold_ms=0, collapse_ms=0, max_per_minute=1000)
        stream = watch.EventStream(watcher, maxsize=1)
        try:
            # The patch has to span the awaits, not just the observes: the
            # handover is `call_soon_threadsafe`, so the batch is enqueued —
            # and the overflow reported — when the loop next runs, not when
            # the event happened.
            with patch("sys.stderr"):
                for index in range(6):
                    watcher.observe(snap([row("a", "idle")], at=at(index * 2)))
                    watcher.observe(snap([row("a", "blocked")], at=at(index * 2 + 1)))
                first = await stream.next_frame(timeout=0.05)
                second = await stream.next_frame(timeout=0.01)
        finally:
            stream.close()
        self.assertTrue(first["events"], "the one batch that fit is delivered")
        self.assertTrue(second.get("keepalive"), "the rest were dropped, not queued forever")
        # And the poll picks them up, because the two feeds share the cursor.
        self.assertTrue(len(watcher.since(first["seq"])["events"]) > 0)

    async def test_closing_the_stream_leaves_the_watcher_with_no_listeners(self):
        watcher = watch.Watcher()
        stream = watch.EventStream(watcher)
        stream.close()
        watcher.observe(snap([row("a", "working")]))
        watcher.observe(snap([], at=at(3)))
        # Nothing was queued for a socket nobody is reading.
        frame = await stream.next_frame(timeout=0.01)
        self.assertTrue(frame.get("keepalive"))


class RunnerTest(unittest.TestCase):
    def test_the_interval_can_be_switched_off_without_editing_the_file(self):
        with patch.dict("os.environ", {watch.INTERVAL_ENV: "0"}):
            self.assertEqual(watch.interval_from({"interval_s": 30}), 0.0)
        with patch.dict("os.environ", {watch.INTERVAL_ENV: "nonsense"}):
            self.assertEqual(watch.interval_from({}), watch.DEFAULT_INTERVAL_S)
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(watch.interval_from({"interval_s": 30}), 30.0)
            self.assertEqual(watch.interval_from({"interval_s": "soon"}), watch.DEFAULT_INTERVAL_S)

    def test_no_thread_is_started_when_the_interval_is_zero(self):
        self.assertIsNone(watch.ensure_runner(watch.Watcher(), 0))

    def test_a_snapshot_that_fails_does_not_end_the_loop(self):
        import threading

        stop = threading.Event()
        attempts = []

        def collect(_dispatcher=None):
            attempts.append(1)
            if len(attempts) < 3:
                raise RuntimeError("herdr exploded")
            stop.set()
            return snap([row("a")])

        with patch.object(watch, "collect_snapshot", collect):
            watch.run_forever(watch.Watcher(), 0, stop=stop)
        self.assertEqual(len(attempts), 3, "two failures then a good one")


if __name__ == "__main__":
    unittest.main()
