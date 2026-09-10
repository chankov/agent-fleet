"""Slice 3 — the join and the output allowlist. Pure data in, pure data out.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/sessions.test.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sessions import build_sessions, match_panes  # noqa: E402


def entry(name, **overrides):
    return {
        "session_id": f"01SESSION{name.upper()}",
        "name": name,
        "purpose": f"{name} purpose",
        "model": "minimax-m3:cloud",
        "color": "#FFAA8B",
        "pid": 4164891,
        "endpoint": f"/home/nchankov/.pi/coms/sockets/{name}.sock",
        "cwd": "/home/nchankov/repos/agent-fleet",
        "started_at": "2026-07-26T14:19:35.944Z",
        "explicit": False,
        "version": 1,
        "heartbeat_at": "2026-07-26T14:19:35.944Z",
        "context_used_pct": 12,
        "queue_depth": 0,
        **overrides,
    }


def pane(state, pane_id, agent="pi", focused=False):
    return {"state": state, "pane_id": pane_id, "agent": agent, "focused": focused}


class MatchPanesTest(unittest.TestCase):
    def test_exact_project_and_name_wins(self):
        matched = match_panes([("af", "reviewer")], {("af", "reviewer"): pane("working", "wA:p1")})
        self.assertEqual(matched[("af", "reviewer")]["pane_id"], "wA:p1")

    def test_the_same_name_in_two_projects_resolves_to_its_own_pane(self):
        # The regression this key exists for. Both are live, both are annotated,
        # and neither may inherit the other's state.
        matched = match_panes(
            [("default", "orchestrator"), ("test-project", "orchestrator")],
            {
                ("default", "orchestrator"): pane("idle", "wA:p13"),
                ("test-project", "orchestrator"): pane("working", "wA:p1X"),
            },
        )
        self.assertEqual(matched[("default", "orchestrator")]["state"], "idle")
        self.assertEqual(matched[("test-project", "orchestrator")]["state"], "working")

    def test_a_pane_scoped_to_another_project_is_not_borrowed(self):
        matched = match_panes([("af", "reviewer")], {("other", "reviewer"): pane("working", "wA:p1")})
        self.assertEqual(matched, {})

    def test_an_unscoped_legacy_pane_joins_a_unique_name(self):
        # herdr <= 0.7.3 could not carry the project; a name owned by exactly one
        # registry entry is still unambiguous.
        matched = match_panes([("af", "reviewer")], {(None, "reviewer"): pane("working", "wA:p1")})
        self.assertEqual(matched[("af", "reviewer")]["pane_id"], "wA:p1")

    def test_an_unscoped_legacy_pane_will_not_guess_between_two_projects(self):
        matched = match_panes(
            [("default", "orchestrator"), ("test-project", "orchestrator")],
            {(None, "orchestrator"): pane("working", "wA:p1")},
        )
        self.assertEqual(matched[("default", "orchestrator")], {"state": "unknown", "ambiguous": True})
        self.assertEqual(matched[("test-project", "orchestrator")], {"state": "unknown", "ambiguous": True})

    def test_a_truncated_peer_name_still_joins_by_prefix(self):
        # The legacy 32-char cap can eat the ` <pct>% q<n>` tail, leaving
        # parse_peer_name with the raw string; one prefix candidate is unambiguous.
        matched = match_panes(
            [("af", "a-very-long-peer-name-here")],
            {(None, "a-very-long-peer-name-here 7%"): pane("idle", "wA:p2")},
        )
        self.assertEqual(matched[("af", "a-very-long-peer-name-here")]["pane_id"], "wA:p2")

    def test_an_exact_match_is_not_stolen_by_a_prefix_neighbour(self):
        matched = match_panes(
            [("af", "reviewer"), ("af", "reviewer2")],
            {(None, "reviewer"): pane("idle", "wA:p1"), (None, "reviewer2"): pane("working", "wA:p2")},
        )
        self.assertEqual(matched[("af", "reviewer")]["pane_id"], "wA:p1")
        self.assertEqual(matched[("af", "reviewer2")]["pane_id"], "wA:p2")

    def test_a_shared_name_with_no_pane_at_all_is_detached_not_ambiguous(self):
        # Ambiguity is competing evidence. With an empty pool there is none —
        # both sessions are simply not in a pane, and saying "unknown" here
        # blames herdr for something herdr answered perfectly well.
        matched = match_panes([("default", "orchestrator"), ("test-project", "orchestrator")], {})
        self.assertEqual(matched, {})

    def test_an_ambiguous_prefix_stays_unknown_instead_of_guessing(self):
        matched = match_panes(
            [("af", "rev")],
            {(None, "reviewer 1% q0"): pane("working", "wA:p1"), (None, "revamp 2% q0"): pane("idle", "wA:p2")},
        )
        self.assertEqual(matched[("af", "rev")], {"state": "unknown", "ambiguous": True})


class BuildSessionsTest(unittest.TestCase):
    def test_two_panes_on_one_project_stay_two_rows(self):
        # The requirement this whole design exists for: a pi pane and a Claude
        # Code pane against the same repo — identical cwd, different peers.
        projects = {"agent-fleet-hub": [entry("orchestrator"), entry("reviewer", model="claude-code")]}
        panes = {
            ("agent-fleet-hub", "orchestrator"): pane("working", "wA:p13", agent="pi", focused=True),
            ("agent-fleet-hub", "reviewer"): pane("blocked", "w28:p3", agent="claude"),
        }
        payload = build_sessions(projects, panes)
        rows = payload["projects"][0]["sessions"]
        self.assertEqual(len(rows), 2)
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(by_name["orchestrator"]["state"], "working")
        self.assertEqual(by_name["orchestrator"]["pane_id"], "wA:p13")
        self.assertEqual(by_name["orchestrator"]["agent"], "pi")
        self.assertEqual(by_name["reviewer"]["state"], "blocked")
        self.assertEqual(by_name["reviewer"]["pane_id"], "w28:p3")
        self.assertEqual(by_name["reviewer"]["agent"], "claude")

    def test_two_projects_sharing_a_name_are_both_detached_when_herdr_has_no_panes(self):
        projects = {"default": [entry("orchestrator")], "test-project": [entry("orchestrator")]}
        payload = build_sessions(projects, {})
        states = {group["sessions"][0]["state"] for group in payload["projects"]}
        self.assertEqual(states, {"detached"})

    def test_a_session_without_a_pane_is_detached_not_hidden(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, {})
        row = payload["projects"][0]["sessions"][0]
        self.assertEqual(row["state"], "detached")
        self.assertIs(row["needs_answer"], False)
        self.assertIsNone(row["pane_id"])

    def test_a_pane_without_a_registry_entry_is_not_shown(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, {("alpha", "stranger"): pane("working", "wA:p9")})
        rows = payload["projects"][0]["sessions"]
        self.assertEqual([row["name"] for row in rows], ["orchestrator"])

    def test_herdr_down_degrades_every_row_to_unknown_and_says_so(self):
        payload = build_sessions({"alpha": [entry("orchestrator"), entry("reviewer")]}, None)
        self.assertIs(payload["herdr"], False)
        self.assertEqual({row["state"] for row in payload["projects"][0]["sessions"]}, {"unknown"})
        self.assertEqual(len(payload["projects"][0]["sessions"]), 2, "sessions must survive a dead herdr")

    def test_herdr_up_with_no_panes_is_a_different_answer_than_herdr_down(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, {})
        self.assertIs(payload["herdr"], True)
        self.assertEqual(payload["projects"][0]["sessions"][0]["state"], "detached")

    def test_needs_answer_floats_to_the_top_of_the_project_and_the_list(self):
        projects = {
            "zulu": [entry("documenter"), entry("reviewer")],
            "alpha": [entry("orchestrator")],
        }
        panes = {
            ("zulu", "documenter"): pane("idle", "wA:p1"),
            ("zulu", "reviewer"): pane("blocked", "wA:p2"),
            ("alpha", "orchestrator"): pane("working", "wA:p3"),
        }
        payload = build_sessions(projects, panes)
        self.assertEqual([group["project"] for group in payload["projects"]], ["zulu", "alpha"])
        self.assertEqual([row["name"] for row in payload["projects"][0]["sessions"]], ["reviewer", "documenter"])
        self.assertIs(payload["projects"][0]["sessions"][0]["needs_answer"], True)

    def test_projects_without_a_waiting_agent_stay_alphabetical(self):
        projects = {"zulu": [entry("a")], "alpha": [entry("b")], "mike": [entry("c")]}
        payload = build_sessions(projects, {})
        self.assertEqual([group["project"] for group in payload["projects"]], ["alpha", "mike", "zulu"])

    def test_the_row_carries_only_allowlisted_fields(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, {("alpha", "orchestrator"): pane("working", "wA:p13")})
        row = payload["projects"][0]["sessions"][0]
        self.assertEqual(
            sorted(row),
            sorted([
                "name", "model", "purpose", "cwd", "started_at", "heartbeat_at",
                "context_used_pct", "queue_depth", "uptime_s", "heartbeat_age_s", "stale",
                "repo", "state", "needs_answer", "agent", "pane_id", "focused", "workspace_id",
            ]),
        )
        for forbidden in ("endpoint", "pid", "session_id", "terminal_id", "color", "explicit"):
            self.assertNotIn(forbidden, row, f"{forbidden} must not reach the renderer")


class AgeAndFreshnessTest(unittest.TestCase):
    """Uptime, heartbeat age and staleness are derived HERE, not in the pane:
    the renderer holds a snapshot up to 3s old and cannot know when it was
    taken."""

    NOW_MS = 1785043200000.0  # 2026-07-26T05:20:00Z, an arbitrary fixed clock

    def rows(self, **overrides):
        payload = build_sessions({"alpha": [entry("orchestrator", **overrides)]}, {}, now_ms=self.NOW_MS)
        return payload["projects"][0]["sessions"][0]

    def test_uptime_and_heartbeat_age_are_whole_seconds_from_the_collection_clock(self):
        row = self.rows(
            started_at="2026-07-26T05:00:00.000Z",
            heartbeat_at="2026-07-26T05:19:30.000Z",
        )
        self.assertEqual(row["uptime_s"], 1200)
        self.assertEqual(row["heartbeat_age_s"], 30)
        self.assertIs(row["stale"], False)

    def test_a_heartbeat_older_than_the_freshness_window_is_stale(self):
        row = self.rows(heartbeat_at="2026-07-26T05:17:00.000Z")
        self.assertEqual(row["heartbeat_age_s"], 180)
        self.assertIs(row["stale"], True, "the session is still live by PID, but it stopped reporting")

    def test_a_clock_ahead_of_the_gateway_never_produces_a_negative_age(self):
        row = self.rows(started_at="2026-07-26T05:30:00.000Z")
        self.assertEqual(row["uptime_s"], 0)

    def test_an_entry_from_an_older_coms_says_nothing_rather_than_zero(self):
        row = self.rows(started_at=None, heartbeat_at=None)
        self.assertIsNone(row["uptime_s"])
        self.assertIsNone(row["heartbeat_age_s"])
        self.assertIs(row["stale"], False, "no heartbeat at all is not evidence of a stale one")


class PaneTotalTest(unittest.TestCase):
    def test_the_pane_total_is_reported_so_detached_can_be_explained(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, {}, pane_total=7)
        self.assertEqual(payload["herdr_panes"], 7)

    def test_a_herdr_that_was_never_asked_reports_no_count_at_all(self):
        payload = build_sessions({"alpha": [entry("orchestrator")]}, None, pane_total=7)
        self.assertIsNone(payload["herdr_panes"])

    def test_repo_is_the_cwd_basename(self):
        payload = build_sessions({"alpha": [entry("a", cwd="/media/data/repos/publicapi/")]}, {})
        self.assertEqual(payload["projects"][0]["sessions"][0]["repo"], "publicapi")

    def test_collected_at_is_stamped(self):
        self.assertEqual(build_sessions({}, {}, collected_at="2026-07-26T21:00:00Z")["collected_at"], "2026-07-26T21:00:00Z")
        self.assertTrue(build_sessions({}, {})["collected_at"].endswith("Z"))

    def test_no_live_sessions_is_an_empty_project_list_not_an_error(self):
        self.assertEqual(build_sessions({}, {})["projects"], [])


if __name__ == "__main__":
    unittest.main()
