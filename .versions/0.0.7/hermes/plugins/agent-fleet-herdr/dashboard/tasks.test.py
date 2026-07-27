"""Phase 4 — the monitor's task tree, folded into the herdr pane.

No monitor process and no socket: `monitor` is substituted with a fake that
answers the same three calls the real adapter does. The one test that DOES touch
the filesystem is the import of the sibling plugin, because "the monitor plugin
is installed beside this one" is the assumption the whole module rests on and it
is the one thing a fake cannot prove.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/tasks.test.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tasks  # noqa: E402

PANE = "wA:p1X"
OTHER_PANE = "wB:p9Z"


def parent(task_id="turn-1", generation=1, state="running", **extra):
    return {
        "id": task_id,
        "generation": generation,
        "kind": "parent",
        "state": state,
        "hubInstanceId": "hub-abc",
        "checkoutId": "checkout-secret",
        "ownerSessionId": "11111111-1111-1111-1111-111111111111",
        "ownerLeaseExpiresAt": "2026-07-27T10:00:00Z",
        **extra,
    }


def child(task_id="run-builder-1", generation=1, state="running", pane=PANE, **extra):
    return {
        "id": task_id,
        "generation": generation,
        "kind": "child",
        "state": state,
        "parentId": "turn-1",
        "parentGeneration": 1,
        "specialist": "builder",
        "hubPaneId": pane,
        "workspaceId": "wA",
        "hubInstanceId": "hub-abc",
        "outputSequence": 3,
        "ownerSessionId": "11111111-1111-1111-1111-111111111111",
        **extra,
    }


class FakeMonitor:
    """The three calls tasks.py makes, with a record of how they were made."""

    def __init__(self, task_list, output_text="hello", fail_snapshot=False, fail_output=False):
        self.task_list = task_list
        self.output_text = output_text
        self.fail_snapshot = fail_snapshot
        self.fail_output = fail_output
        self.output_calls = []
        self.cancel_calls = []

    def snapshot(self):
        if self.fail_snapshot:
            raise RuntimeError("monitor is down")
        return {"tasks": self.task_list}

    def output(self, task_id, generation, after, hub=None):
        self.output_calls.append((task_id, generation, after, hub))
        if self.fail_output:
            raise RuntimeError("gone")
        return {"text": self.output_text, "sequence": 3, "truncated": False}

    def cancel(self, task_id, generation, hub=None):
        self.cancel_calls.append((task_id, generation, hub))
        return {"cancelled": True, "reason": "signalled"}


class TreeTest(unittest.TestCase):
    def test_a_child_joins_its_hub_by_pane_id_and_brings_its_parent(self):
        monitor = FakeMonitor([parent(), child()])
        result = tasks.tasks_for_pane(PANE, monitor=monitor)
        self.assertTrue(result["available"])
        self.assertEqual(len(result["tasks"]), 1)
        root = result["tasks"][0]
        self.assertEqual(root["id"], "turn-1")
        self.assertEqual([c["id"] for c in root["children"]], ["run-builder-1"])

    def test_another_hubs_tasks_are_not_shown_on_this_row(self):
        # The failure this join exists to prevent: two hubs on one machine, one
        # panel, and a task tree attributed to whichever row was clicked.
        monitor = FakeMonitor([parent(), child(pane=OTHER_PANE)])
        self.assertEqual(tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"], [])

    def test_a_detached_session_says_why_rather_than_showing_nothing(self):
        result = tasks.tasks_for_pane(None, monitor=FakeMonitor([parent(), child()]))
        self.assertFalse(result["available"])
        self.assertIn("pane", result["reason"])
        self.assertEqual(result["tasks"], [])

    def test_two_hubs_numbering_their_turns_alike_do_not_cross_attach(self):
        # FleetMonitorAdapter merges every hub under the profile into one list,
        # and nothing stops two hubs from calling a turn `turn-1`. Matching a
        # parent on (id, generation) alone would hang this pane's specialist
        # under the other hub's turn.
        monitor = FakeMonitor([
            parent(),                                        # hub-abc, turn-1
            parent(**{"hubInstanceId": "hub-xyz"}),          # hub-xyz, turn-1 too
            child(),                                         # this pane, hub-abc
        ])
        roots = tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["hubInstanceId"], "hub-abc")
        self.assertEqual([c["id"] for c in roots[0]["children"]], ["run-builder-1"])

    def test_a_running_child_whose_parent_was_pruned_is_kept_and_flagged(self):
        monitor = FakeMonitor([child()])  # no parent in the snapshot
        roots = tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["id"], "run-builder-1")
        self.assertTrue(roots[0]["orphaned_parent"])

    def test_an_empty_but_reachable_monitor_is_available_with_no_tasks(self):
        # "This hub has spawned nothing" and "there is no monitor" are different
        # sentences; only the second is an absence of a source.
        result = tasks.tasks_for_pane(PANE, monitor=FakeMonitor([]))
        self.assertTrue(result["available"])
        self.assertEqual(result["tasks"], [])


class AllowlistTest(unittest.TestCase):
    def test_lease_and_correlation_fields_never_reach_the_renderer(self):
        monitor = FakeMonitor([parent(), child()])
        roots = tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"]
        flat = [roots[0], *roots[0]["children"]]
        for task in flat:
            for banned in ("ownerSessionId", "ownerLeaseExpiresAt", "checkoutId", "workspaceId", "hubPaneId"):
                self.assertNotIn(banned, task, f"{banned} leaked into the payload")

    def test_an_unknown_field_the_monitor_grows_later_does_not_travel(self):
        monitor = FakeMonitor([parent(), child(endpoint="/run/user/1000/coms/x.sock")])
        roots = tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"]
        self.assertNotIn("endpoint", roots[0]["children"][0])

    def test_hub_instance_id_does_travel_because_cancel_is_addressed_with_it(self):
        roots = tasks.tasks_for_pane(PANE, monitor=FakeMonitor([parent(), child()]))["tasks"]
        self.assertEqual(roots[0]["children"][0]["hubInstanceId"], "hub-abc")


class OutputTest(unittest.TestCase):
    def test_only_live_tasks_with_output_cost_a_socket_round_trip(self):
        monitor = FakeMonitor([
            parent(),  # a hub turn with no output of its own
            child("a", state="running"),
            child("b", state="completed"),
            child("c", state="running", outputSequence=0),
        ])
        tasks.tasks_for_pane(PANE, monitor=monitor)
        # `b` has finished and `c` has written nothing; neither is worth a
        # connection, and the parent has no output sequence at all.
        self.assertEqual([call[0] for call in monitor.output_calls], ["a"])

    def test_the_output_read_budget_caps_a_runaway_hub(self):
        many = [parent()] + [child(f"run-{i}") for i in range(30)]
        monitor = FakeMonitor(many)
        tasks.tasks_for_pane(PANE, monitor=monitor)
        self.assertEqual(len(monitor.output_calls), tasks.MAX_OUTPUT_READS)

    def test_output_is_the_tail_not_the_head(self):
        monitor = FakeMonitor([parent(), child()], output_text="A" * 10 + "B" * tasks.MAX_OUTPUT_CHARS)
        roots = tasks.tasks_for_pane(PANE, monitor=monitor)["tasks"]
        text = roots[0]["children"][0]["output"]
        self.assertEqual(len(text), tasks.MAX_OUTPUT_CHARS)
        self.assertTrue(text.endswith("B"))
        self.assertNotIn("A", text)

    def test_a_failed_output_read_costs_the_output_not_the_tree(self):
        monitor = FakeMonitor([parent(), child()], fail_output=True)
        result = tasks.tasks_for_pane(PANE, monitor=monitor)
        self.assertTrue(result["available"])
        self.assertNotIn("output", result["tasks"][0]["children"][0])


class FailureTest(unittest.TestCase):
    def test_a_monitor_that_stops_answering_is_a_sentence_not_an_exception(self):
        result = tasks.tasks_for_pane(PANE, monitor=FakeMonitor([], fail_snapshot=True))
        self.assertFalse(result["available"])
        self.assertIn("not answering", result["reason"])

    def test_a_snapshot_that_is_not_a_task_list_is_refused_rather_than_iterated(self):
        class Weird:
            def snapshot(self):
                return {"tasks": "not-a-list"}

        self.assertFalse(tasks.tasks_for_pane(PANE, monitor=Weird())["available"])

    def test_no_monitor_registered_for_this_profile_reads_as_an_absence(self):
        # The ordinary case: a hub started without the two variables. It must
        # not look like a broken panel.
        result = tasks.tasks_for_pane(PANE, env={"AGENT_FLEET_PROFILE_ID": "dev", "AGENT_FLEET_MONITOR_RUNTIME_DIR": "/nonexistent-runtime"})
        self.assertFalse(result["available"])
        self.assertEqual(result["tasks"], [])


class CancelTest(unittest.TestCase):
    def test_cancel_reaches_the_monitor_with_the_hub_the_snapshot_named(self):
        monitor = FakeMonitor([parent(), child()])
        result = tasks.cancel_task(PANE, "run-builder-1", 1, monitor=monitor)
        self.assertTrue(result["cancelled"])
        self.assertEqual(monitor.cancel_calls, [("run-builder-1", 1, "hub-abc")])

    def test_a_task_belonging_to_another_hub_cannot_be_cancelled_from_this_row(self):
        # Without the re-check, this route would cancel any task in any hub on
        # the machine for anyone who could guess an id.
        monitor = FakeMonitor([parent(), child(pane=OTHER_PANE)])
        with self.assertRaises(LookupError):
            tasks.cancel_task(PANE, "run-builder-1", 1, monitor=monitor)
        self.assertEqual(monitor.cancel_calls, [])

    def test_a_forged_hub_instance_id_in_the_request_is_ignored(self):
        monitor = FakeMonitor([parent(), child()])
        tasks.cancel_task(PANE, "run-builder-1", 1, hub_instance_id="hub-somebody-else", monitor=monitor)
        self.assertEqual(monitor.cancel_calls[0][2], "hub-abc")

    def test_an_already_finished_task_is_refused_with_its_state(self):
        monitor = FakeMonitor([parent(), child(state="completed")])
        with self.assertRaises(LookupError) as caught:
            tasks.cancel_task(PANE, "run-builder-1", 1, monitor=monitor)
        self.assertIn("completed", str(caught.exception))
        self.assertEqual(monitor.cancel_calls, [])

    def test_the_wrong_generation_is_a_different_task(self):
        monitor = FakeMonitor([parent(), child(generation=2)])
        with self.assertRaises(LookupError):
            tasks.cancel_task(PANE, "run-builder-1", 1, monitor=monitor)


class SiblingImportTest(unittest.TestCase):
    def test_the_monitor_adapter_really_is_importable_from_this_checkout(self):
        # The assumption the module rests on, and the one a fake cannot prove.
        module = tasks._load_adapter()
        self.assertTrue(hasattr(module, "MonitorAdapter"))
        self.assertTrue(hasattr(module, "MonitorUnavailable"))

    def test_a_missing_monitor_plugin_is_reported_as_an_absence(self):
        original = tasks._load_adapter
        sys.modules.pop("_agent_fleet_monitor_adapter", None)
        try:
            tasks._load_adapter = lambda: (_ for _ in ()).throw(tasks.MonitorMissing("no monitor adapter at /nowhere"))
            result = tasks.tasks_for_pane(PANE)
            self.assertFalse(result["available"])
            self.assertIn("no monitor adapter", result["reason"])
        finally:
            tasks._load_adapter = original


if __name__ == "__main__":
    unittest.main()
