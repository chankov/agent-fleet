"""Slice 4 — the HTTP boundary, with both sources substituted.

Needs fastapi + httpx (both present in the Hermes venv).
Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/plugin-api.test.py
"""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import activity  # noqa: E402
import coms_registry  # noqa: E402
import herdr_source  # noqa: E402
import plugin_api  # noqa: E402
import tasks  # noqa: E402
import watch  # noqa: E402

# The first /sessions request starts the background watcher, which polls the
# REAL registry and shells out to herdr on a timer. A test suite gets the
# request-driven half only; the runner has its own test in watch.test.py.
plugin_api._WATCH_INTERVAL_S = 0

ENTRY = {
    "name": "orchestrator",
    "model": "minimax-m3:cloud",
    "purpose": "Verification-Contract orchestrator",
    "cwd": "/home/nchankov/repos/agent-fleet",
    "started_at": "2026-07-26T14:19:35.944Z",
    "context_used_pct": 12,
    "queue_depth": 0,
    "pid": 4164891,
    "session_id": "01KYCQR3VF4674CF0MPQV2DJYS",
    "endpoint": "/home/nchankov/.pi/coms/sockets/01KYCQR3VF4674CF0MPQV2DJYS.sock",
    "version": 1,
}


def client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/agent-fleet-herdr")
    return TestClient(app)


class SessionsEndpointTest(unittest.TestCase):
    def get(self):
        return client().get("/api/plugins/agent-fleet-herdr/sessions")

    def test_returns_projects_from_both_sources(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            herdr_source,
            "pane_snapshot",
            return_value=({("alpha", "orchestrator"): {"state": "working", "pane_id": "wA:p13", "agent": "pi"}}, 4),
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIs(payload["herdr"], True)
        row = payload["projects"][0]["sessions"][0]
        self.assertEqual((row["name"], row["state"], row["pane_id"]), ("orchestrator", "working", "wA:p13"))

    def test_the_pane_total_travels_so_detached_can_be_explained(self):
        """A row is `detached` for two very different reasons — herdr sees no
        panes at all, or it sees panes and none of them is this peer."""
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            herdr_source, "pane_snapshot", return_value=({}, 7)
        ):
            payload = self.get().json()
        self.assertEqual(payload["projects"][0]["sessions"][0]["state"], "detached")
        self.assertEqual(payload["herdr_panes"], 7)

    def test_dead_herdr_is_200_with_unknown_rows_not_503(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            herdr_source, "pane_snapshot", side_effect=herdr_source.HerdrUnavailable("herdr not found on PATH")
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIs(payload["herdr"], False)
        self.assertIsNone(payload["herdr_panes"], "an unasked herdr has no pane count, not a count of zero")
        self.assertEqual(payload["projects"][0]["sessions"][0]["state"], "unknown")

    def test_unreadable_registry_is_503_with_a_reason(self):
        with patch.object(
            coms_registry, "live_sessions_by_project", side_effect=coms_registry.RegistryUnavailable("cannot read /nope")
        ):
            response = self.get()
        self.assertEqual(response.status_code, 503)
        self.assertIn("coms registry unavailable", response.json()["detail"])

    def test_an_unexpected_read_fault_is_503_never_500(self):
        with patch.object(coms_registry, "live_sessions_by_project", side_effect=RuntimeError("boom")):
            response = self.get()
        self.assertEqual(response.status_code, 503)

    def test_no_live_sessions_is_an_empty_list_not_an_error(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={}), patch.object(
            herdr_source, "pane_snapshot", return_value=({}, 0)
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["projects"], [])

    def test_socket_paths_and_pids_never_leave_the_backend(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            herdr_source, "pane_snapshot", return_value=({}, 0)
        ):
            body = self.get().text
        for forbidden in (ENTRY["endpoint"], ENTRY["session_id"], str(ENTRY["pid"])):
            self.assertNotIn(forbidden, body)


class FocusEndpointTest(unittest.TestCase):
    def post(self, project="alpha", name="orchestrator"):
        return client().post(f"/api/plugins/agent-fleet-herdr/sessions/{project}/{name}/focus")

    def test_focuses_the_workspace_that_hosts_the_peer(self):
        calls = []
        panes = {("alpha", "orchestrator"): {"state": "working", "pane_id": "wA:p13", "workspace_id": "wA"}}
        with patch.object(herdr_source, "pane_snapshot", return_value=(panes, 1)), patch.object(
            herdr_source, "focus_workspace", side_effect=lambda ws: calls.append(ws)
        ):
            response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"focused": "wA"})
        self.assertEqual(calls, ["wA"])

    def test_a_detached_peer_has_nothing_to_focus(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=({}, 3)):
            response = self.post()
        self.assertEqual(response.status_code, 422)
        self.assertIn("not in a herdr pane", response.json()["detail"])

    def test_a_dead_herdr_says_so_rather_than_pretending(self):
        with patch.object(herdr_source, "pane_snapshot", side_effect=herdr_source.HerdrUnavailable("no socket")):
            response = self.post()
        self.assertEqual(response.status_code, 503)

    def test_a_malformed_name_never_reaches_herdr(self):
        # `..` is collapsed by the router before it ever gets here (404); this
        # is the case that DOES reach the handler and must be refused by it.
        with patch.object(herdr_source, "pane_snapshot", return_value=({}, 0)) as snapshot:
            response = self.post(name="orchestrator!")
        self.assertEqual(response.status_code, 422)
        snapshot.assert_not_called()


class HerdrFocusArgumentTest(unittest.TestCase):
    def test_only_a_herdr_shaped_workspace_id_reaches_argv(self):
        calls = []
        herdr_source.focus_workspace("wA", run=lambda args, timeout: calls.append(args) or "")
        self.assertEqual(calls, [["herdr", "workspace", "focus", "wA"]])

        for hostile in ("", "-rf", "wA; rm -rf /", "../wA", None, 7):
            with self.assertRaises(herdr_source.HerdrUnavailable):
                herdr_source.focus_workspace(hostile, run=lambda args, timeout: calls.append(args) or "")
        self.assertEqual(len(calls), 1, "nothing hostile may reach the command line")


class EventsEndpointTest(unittest.TestCase):
    """The other half of /sessions: polling it is what produces the events."""

    def sessions(self, projects):
        with patch.object(coms_registry, "live_sessions_by_project", return_value=projects), patch.object(
            herdr_source, "pane_snapshot", return_value=({("alpha", "orchestrator"): {"state": "idle"}}, 1)
        ):
            return client().get("/api/plugins/agent-fleet-herdr/sessions")

    def events(self, after=0):
        return client().get(f"/api/plugins/agent-fleet-herdr/events?after={after}").json()

    def test_a_session_that_ends_is_reported_to_whoever_asks_next(self):
        # The watcher is per process and shared with every other test in this
        # file, so the cursor is taken now rather than assumed to be zero.
        start = self.events()["seq"]
        self.sessions({"alpha": [ENTRY]})
        self.sessions({})

        payload = self.events(start)
        kinds = [event["kind"] for event in payload["events"]]
        self.assertIn("finished", kinds)
        self.assertGreater(payload["seq"], start)
        ended = next(event for event in payload["events"] if event["kind"] == "finished")
        self.assertEqual((ended["project"], ended["name"]), ("alpha", "orchestrator"))

    def test_the_cursor_hands_back_each_event_exactly_once(self):
        start = self.events()["seq"]
        self.sessions({"alpha": [ENTRY]})
        self.sessions({})
        seq = self.events(start)["seq"]
        self.assertEqual(self.events(seq)["events"], [], "an up-to-date client is told nothing twice")

    def test_events_answers_before_anything_has_ever_been_observed(self):
        payload = client().get("/api/plugins/agent-fleet-herdr/events").json()
        self.assertIn("events", payload)
        self.assertIsInstance(payload["seq"], int)


class EventStreamRouteTest(unittest.TestCase):
    """The push feed. Everything it delivers, `GET /events` also delivers — what
    is checked here is the gate in front of it and the shape of a frame."""

    def setUp(self):
        # A watcher per test, not the process-wide one. Two tests that end the
        # same session are two identical transitions, and the 60s collapse
        # window would hand the event to whichever ran first — a test that
        # passes or fails depending on its neighbours.
        fresh = patch.object(plugin_api, "_watcher", watch.Watcher())
        fresh.start()
        self.addCleanup(fresh.stop)
        gate = patch.object(plugin_api, "_socket_gate", return_value=None)
        gate.start()
        self.addCleanup(gate.stop)

    def connect(self, query=""):
        return client().websocket_connect(f"/api/plugins/agent-fleet-herdr/events/stream{query}")

    def sessions(self, projects):
        with patch.object(coms_registry, "live_sessions_by_project", return_value=projects), patch.object(
            herdr_source, "pane_snapshot", return_value=({("alpha", "orchestrator"): {"state": "idle"}}, 1)
        ):
            return client().get("/api/plugins/agent-fleet-herdr/sessions")

    def test_an_upgrade_this_backend_cannot_authenticate_is_refused(self):
        """Every gateway middleware is registered for the `http` scope, so this
        route reaches us with NOTHING checked. A backend that cannot resolve the
        gateway's own check must close rather than serve — the pane keeps
        polling, which is why the poll was kept."""
        with patch.object(plugin_api, "_socket_gate", return_value="no gateway"):
            with self.assertRaises(WebSocketDisconnect):
                with self.connect():
                    pass

    def test_an_authorised_upgrade_opens_with_the_backlog(self):
        with self.connect() as socket:
            first = socket.receive_json()
        self.assertIn("events", first)
        self.assertIsInstance(first["seq"], int)

    def test_a_client_naming_its_cursor_is_not_replayed_the_backlog(self):
        self.sessions({"alpha": [ENTRY]})
        self.sessions({})
        seq = client().get("/api/plugins/agent-fleet-herdr/events").json()["seq"]

        with self.connect(f"?after={seq}") as socket:
            first = socket.receive_json()
        self.assertEqual(first, {"events": [], "seq": seq})

    def test_a_transition_after_the_socket_opened_arrives_as_a_frame(self):
        with self.connect() as socket:
            socket.receive_json()  # the backlog
            self.sessions({"alpha": [ENTRY]})
            self.sessions({})
            frame = socket.receive_json()
        self.assertIn("finished", [event["kind"] for event in frame["events"]])

    def test_a_frame_is_shaped_exactly_like_a_poll_answer(self):
        """The two feeds go through one handler in the pane. A frame that
        needed its own branch would be a second implementation of the same
        thing, and the poll would stop being a real fallback."""
        with self.connect() as socket:
            socket.receive_json()
            self.sessions({"alpha": [ENTRY]})
            self.sessions({})
            frame = socket.receive_json()
        polled = client().get("/api/plugins/agent-fleet-herdr/events").json()
        self.assertEqual(sorted(frame), sorted(polled))
        self.assertEqual(sorted(frame["events"][0]), sorted(polled["events"][0]))


class SocketGateTest(unittest.TestCase):
    """The gate itself, against a stand-in for the module that mounted us."""

    def gate(self, host, enabled=None, **query):
        with patch.object(plugin_api, "_host_module", return_value=host), patch.object(
            plugin_api, "_enabled_gate", return_value=enabled
        ):
            return plugin_api._socket_gate(SimpleNamespace(query_params=query))

    def host(self, allowed=True, authorized=True):
        return SimpleNamespace(
            _ws_request_is_allowed=lambda ws: allowed,
            _ws_auth_ok=lambda ws: authorized,
        )

    def test_no_gateway_at_all_is_a_refusal(self):
        self.assertIsNotNone(self.gate(None))

    def test_a_hermes_that_renamed_the_check_is_a_refusal_not_a_free_pass(self):
        """The failure mode this exists to prevent: an upgrade that moves the
        function turning the event feed into an unauthenticated one."""
        self.assertIsNotNone(self.gate(SimpleNamespace()))

    def test_a_bad_credential_and_a_bad_origin_are_both_refused(self):
        self.assertIn("credential", self.gate(self.host(authorized=False)))
        self.assertIn("boundary", self.gate(self.host(allowed=False)))

    def test_a_check_that_raises_refuses_rather_than_crashing_the_gateway(self):
        def explode(_ws):
            raise RuntimeError("the ticket store is gone")

        host = SimpleNamespace(_ws_request_is_allowed=explode, _ws_auth_ok=lambda ws: True)
        self.assertIsNotNone(self.gate(host))

    def test_an_authenticated_upgrade_passes(self):
        self.assertIsNone(self.gate(self.host()))

    def test_a_plugin_that_was_turned_off_stops_pushing(self):
        """The HTTP gate 404s a disabled plugin per request; nothing does that
        for a socket, so the same check is re-done here."""
        self.assertEqual(self.gate(self.host(), enabled="the plugin is not enabled"), "the plugin is not enabled")

    def test_the_enabled_check_reads_the_gateways_own_config(self):
        loader = SimpleNamespace(
            _get_disabled_set=lambda: set(),
            _get_enabled_set=lambda: {"agent-fleet-herdr"},
        )
        with patch.dict(sys.modules, {"hermes_cli.plugins_cmd": loader}):
            self.assertIsNone(plugin_api._enabled_gate())
            loader._get_enabled_set = set
            self.assertIsNotNone(plugin_api._enabled_gate())
            loader._get_enabled_set = lambda: {"agent-fleet-herdr"}
            loader._get_disabled_set = lambda: {"agent-fleet-herdr"}
            self.assertIsNotNone(plugin_api._enabled_gate())

    def test_a_host_without_a_plugin_loader_has_no_enabled_set_to_consult(self):
        with patch.dict(sys.modules, {"hermes_cli.plugins_cmd": None}):
            self.assertIsNone(plugin_api._enabled_gate())


class ActivityEndpointTest(unittest.TestCase):
    """The transcript reader behind the HTTP boundary. `activity.py` has its own
    suite; what is checked here is that the route never turns a missing file
    into an error, and never lets `session_id` or `cwd` decide anything the
    caller can see."""

    def get(self, project="alpha", name="orchestrator", query=""):
        return client().get(f"/api/plugins/agent-fleet-herdr/sessions/{project}/{name}/activity{query}")

    def test_a_session_with_a_transcript_answers_with_its_steps(self):
        steps = [{"seq": 42, "at": "2026-07-27T09:00:00Z", "kind": "tool", "label": "bash", "detail": "git status"}]
        answer = {"available": True, "reason": "", "steps": steps, "current": None, "seq": 42}
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            activity, "activity_for_entry", return_value=answer
        ) as reader:
            response = self.get(query="?after=7&limit=5")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["steps"], steps)
        # The cursor and the budget are the caller's; the ENTRY is not.
        self.assertEqual(reader.call_args.kwargs, {"after": 7, "limit": 5, "pane_id": None})
        self.assertIs(reader.call_args.args[0], ENTRY)

    def test_no_transcript_is_a_200_with_a_reason_not_a_404(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            activity, "find_transcript", return_value=None
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIs(payload["available"], False)
        self.assertIn("no pi transcript", payload["reason"])

    def test_a_session_that_is_not_in_the_registry_is_also_a_200(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}):
            payload = self.get(name="ghost").json()
        self.assertIs(payload["available"], False)
        self.assertIn("ghost", payload["reason"])

    def test_an_unreadable_registry_does_not_take_the_panel_down(self):
        with patch.object(coms_registry, "live_sessions_by_project", side_effect=RuntimeError("boom")):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["available"], False)

    def test_a_transcript_that_explodes_mid_read_is_still_a_200(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            activity, "activity_for_entry", side_effect=UnicodeError("bad byte")
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["available"], False)

    def test_a_malformed_name_is_refused_before_anything_is_read(self):
        with patch.object(coms_registry, "live_sessions_by_project") as registry:
            response = self.get(name="orchestrator!")
        self.assertEqual(response.status_code, 422)
        registry.assert_not_called()

    def test_a_pi_peer_never_pays_for_the_herdr_lookup_a_bridged_one_needs(self):
        """A pi transcript identifies itself. Asking herdr for every activity
        poll would double the panel's subprocess cost to learn nothing."""
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}), patch.object(
            herdr_source, "pane_snapshot"
        ) as snapshot, patch.object(activity, "activity_for_entry", return_value=activity.unavailable("x")):
            self.get()
        snapshot.assert_not_called()

    def test_a_bridged_claude_peer_is_looked_up_through_its_herdr_pane(self):
        # The bridge mints its own coms session id, so the pane is the only way
        # to reach the Stop hook record that names the transcript.
        bridged = {**ENTRY, "name": "code-reviewer", "model": activity.CLAUDE_MODEL}
        panes = {("alpha", "code-reviewer"): {"state": "working", "pane_id": "w1X:p3"}}
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [bridged]}), patch.object(
            herdr_source, "pane_snapshot", return_value=(panes, 3)
        ), patch.object(activity, "activity_for_entry", return_value=activity.unavailable("x")) as reader:
            response = self.get(name="code-reviewer")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(reader.call_args.kwargs["pane_id"], "w1X:p3")

    def test_a_bridged_peer_with_no_pane_is_answered_rather_than_failed(self):
        bridged = {**ENTRY, "name": "code-reviewer", "model": activity.CLAUDE_MODEL}
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [bridged]}), patch.object(
            herdr_source, "pane_snapshot", side_effect=herdr_source.HerdrUnavailable("no socket")
        ):
            payload = self.get(name="code-reviewer").json()
        self.assertIs(payload["available"], False)
        self.assertIn("no herdr pane", payload["reason"])

    def test_the_session_id_and_the_socket_path_never_reach_the_answer(self):
        with patch.object(coms_registry, "live_sessions_by_project", return_value={"alpha": [ENTRY]}):
            body = self.get().text
        for forbidden in (ENTRY["endpoint"], ENTRY["session_id"], str(ENTRY["pid"])):
            self.assertNotIn(forbidden, body)


class CapabilitiesEndpointTest(unittest.TestCase):
    def get(self):
        return client().get("/api/plugins/agent-fleet-herdr/capabilities")

    def test_reports_both_sources_up(self):
        with patch.object(coms_registry, "default_projects_root", return_value=Path(__file__).parent), patch.object(
            herdr_source, "herdr_version", return_value="herdr 0.7.4"
        ):
            payload = self.get().json()
        # `events_stream` is not a source — it is the version marker. Backend
        # routes mount at app construction, so its presence is the honest answer
        # to "has Hermes restarted since the plugin changed".
        self.assertEqual(
            payload,
            {
                "coms_registry": True,
                "herdr": True,
                "herdr_version": "herdr 0.7.4",
                "poll_ms": 3000,
                "events_stream": True,
            },
        )

    def test_reports_the_sources_failing_independently(self):
        with patch.object(coms_registry, "default_projects_root", return_value=Path("/nope/not/here")), patch.object(
            herdr_source, "herdr_version", return_value=None
        ):
            payload = self.get().json()
        self.assertIs(payload["coms_registry"], False)
        self.assertIs(payload["herdr"], False)
        self.assertIsNone(payload["herdr_version"])

    def test_capabilities_never_fails(self):
        with patch.object(coms_registry, "default_projects_root", side_effect=OSError("stat failed")), patch.object(
            herdr_source, "herdr_version", return_value=None
        ):
            self.assertEqual(self.get().status_code, 200)


PANES = {("alpha", "orchestrator"): {"state": "working", "pane_id": "wA:p1X", "workspace_id": "wA"}}


class TasksEndpointTest(unittest.TestCase):
    """The monitor behind the HTTP boundary. `tasks.py` has its own suite; what
    is checked here is the pane join and that an absent monitor — the ordinary
    case, since it is opt-in — never becomes an error."""

    def get(self, project="alpha", name="orchestrator"):
        return client().get(f"/api/plugins/agent-fleet-herdr/sessions/{project}/{name}/tasks")

    def test_the_hubs_pane_id_is_what_the_monitor_is_asked_about(self):
        answer = {"available": True, "reason": "", "tasks": [{"id": "turn-1", "generation": 1, "children": []}]}
        with patch.object(herdr_source, "pane_snapshot", return_value=(PANES, 3)), patch.object(
            tasks, "tasks_for_pane", return_value=answer
        ) as reader:
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tasks"], answer["tasks"])
        # The pane id, and nothing else about the session.
        self.assertEqual(reader.call_args.args, ("wA:p1X",))

    def test_a_detached_session_is_a_200_that_says_why(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=({}, 3)):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIs(payload["available"], False)
        self.assertIn("pane", payload["reason"])

    def test_a_dead_herdr_does_not_take_the_panel_down(self):
        with patch.object(herdr_source, "pane_snapshot", side_effect=herdr_source.HerdrUnavailable("gone")):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["available"], False)

    def test_a_monitor_that_explodes_is_still_a_200(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=(PANES, 3)), patch.object(
            tasks, "tasks_for_pane", side_effect=RuntimeError("socket died")
        ):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["available"], False)

    def test_a_malformed_name_is_refused_before_herdr_is_asked(self):
        with patch.object(herdr_source, "pane_snapshot") as snapshot:
            response = self.get(name="orchestrator!")
        self.assertEqual(response.status_code, 422)
        snapshot.assert_not_called()


class CancelTaskEndpointTest(unittest.TestCase):
    def post(self, project="alpha", name="orchestrator", task_id="run-builder-1", generation=1):
        return client().post(
            f"/api/plugins/agent-fleet-herdr/sessions/{project}/{name}/tasks/{task_id}/{generation}/cancel"
        )

    def test_a_cancel_is_scoped_to_the_pane_the_row_belongs_to(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=(PANES, 3)), patch.object(
            tasks, "cancel_task", return_value={"cancelled": True}
        ) as canceller:
            response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["cancelled"], True)
        # The pane is resolved here; the renderer only ever named the task.
        self.assertEqual(canceller.call_args.args, ("wA:p1X", "run-builder-1", 1))

    def test_a_task_the_monitor_does_not_own_is_a_422_with_the_reason(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=(PANES, 3)), patch.object(
            tasks, "cancel_task", side_effect=LookupError("that task does not belong to this agent")
        ):
            response = self.post()
        self.assertEqual(response.status_code, 422)
        self.assertIn("does not belong", response.json()["detail"])

    def test_a_detached_row_has_nothing_to_cancel(self):
        with patch.object(herdr_source, "pane_snapshot", return_value=({}, 3)), patch.object(
            tasks, "cancel_task"
        ) as canceller:
            response = self.post()
        self.assertEqual(response.status_code, 422)
        canceller.assert_not_called()

    def test_a_malformed_name_never_reaches_the_monitor(self):
        with patch.object(herdr_source, "pane_snapshot") as snapshot, patch.object(tasks, "cancel_task") as canceller:
            response = self.post(name="orchestrator!")
        self.assertEqual(response.status_code, 422)
        snapshot.assert_not_called()
        canceller.assert_not_called()

    def test_a_non_numeric_generation_is_refused_by_the_route_signature(self):
        response = client().post(
            "/api/plugins/agent-fleet-herdr/sessions/alpha/orchestrator/tasks/run-1/latest/cancel"
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
