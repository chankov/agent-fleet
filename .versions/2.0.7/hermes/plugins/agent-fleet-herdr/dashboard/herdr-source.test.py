"""Slice 2 — herdr source. No herdr process is started; `run` is substituted.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/herdr-source.test.py
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from herdr_source import (  # noqa: E402
    HerdrUnavailable,
    herdr_version,
    list_agents,
    normalize_state,
    panes_by_peer_key,
    parse_peer_name,
    peer_key,
    run_herdr,
)

# Recorded from `herdr agent list` on herdr 0.7.4 — the envelope shape
# (`result.agents`) and the pane fields are the contract this module reads.
# 0.7.4 reports the peer annotation as `tokens`; `custom_status` is gone from
# both the request params and this response, which is what broke the join.
LIVE_FIXTURE = {
    "id": "cli:agent:list",
    "result": {
        "type": "agent_list",
        "agents": [
            {
                "agent": "pi",
                "agent_status": "working",
                "tokens": {"coms": "orchestrator", "proj": "agent-fleet", "ctx": "12%", "q": "q0"},
                "cwd": "/home/nchankov/repos/agent-fleet",
                "focused": True,
                "pane_id": "wA:p13",
                "revision": 52,
                "tab_id": "wA:t2",
                "terminal_id": "term_6571e05eba83398",
                "terminal_title_stripped": "π - agent-fleet",
                "workspace_id": "wA",
            },
            {
                "agent": "claude",
                "agent_status": "blocked",
                "tokens": {"coms": "reviewer", "proj": "agent-fleet", "ctx": "3%", "q": "q1"},
                "cwd": "/home/nchankov/repos/agent-fleet",
                "focused": False,
                "pane_id": "w28:p3",
                "terminal_id": "term_deadbeef",
                "workspace_id": "w28",
            },
            {
                "agent": "pi",
                "agent_status": "idle",
                "cwd": "/home/nchankov/repos/other",
                "pane_id": "wA:p1X",
                "workspace_id": "wA",
            },
        ],
    },
}


def canned(payload, *, expect=("herdr", "agent", "list")):
    def run(args, timeout):
        assert tuple(args) == expect, args
        return json.dumps(payload)

    return run


class ParsePeerNameTest(unittest.TestCase):
    def test_strips_the_pct_and_queue_tail(self):
        self.assertEqual(parse_peer_name("orchestrator 12% q0"), "orchestrator")
        self.assertEqual(parse_peer_name("code-reviewer2 100% q12"), "code-reviewer2")

    def test_tolerates_a_tail_truncated_by_the_32_char_server_cap(self):
        # formatPeerStatus() truncates the whole string, so the queue digits can
        # be gone entirely; the name must still come back clean.
        self.assertEqual(parse_peer_name("a-rather-long-peer-name 7% q"), "a-rather-long-peer-name")

    def test_returns_the_raw_string_when_no_tail_survived(self):
        # Matches parsePeerName in herdr-presence.ts: never invent a name.
        self.assertEqual(parse_peer_name("a-very-long-peer-name-here 7%"), "a-very-long-peer-name-here 7%")

    def test_missing_custom_status_is_no_name(self):
        self.assertIsNone(parse_peer_name(None))
        self.assertIsNone(parse_peer_name(""))
        self.assertIsNone(parse_peer_name("   "))


class PeerKeyTest(unittest.TestCase):
    """Which peer a pane claims to be — the join key, in both wire dialects."""

    def test_tokens_carry_the_project(self):
        agent = {"tokens": {"coms": "orchestrator", "proj": "test-project"}}
        self.assertEqual(peer_key(agent), ("test-project", "orchestrator"))

    def test_tokens_without_a_project_are_unscoped_not_defaulted(self):
        self.assertEqual(peer_key({"tokens": {"coms": "solo"}}), (None, "solo"))

    def test_legacy_custom_status_still_resolves_a_name(self):
        self.assertEqual(peer_key({"custom_status": "reviewer 3% q1"}), (None, "reviewer"))

    def test_a_renamed_pane_is_the_last_resort(self):
        # `herdr agent rename` is a human label, not a coms identity.
        self.assertEqual(peer_key({"name": "scratch", "tokens": {"coms": "builder"}}), (None, "builder"))
        self.assertEqual(peer_key({"name": "scratch"}), (None, "scratch"))

    def test_an_unannotated_pane_is_not_a_peer(self):
        self.assertIsNone(peer_key({"pane_id": "wA:p1", "agent": "pi"}))


class NormalizeStateTest(unittest.TestCase):
    def test_known_states_pass_through(self):
        for state in ("idle", "working", "blocked"):
            self.assertEqual(normalize_state(state), state)

    def test_anything_else_is_unknown(self):
        self.assertEqual(normalize_state("starting"), "unknown")
        self.assertEqual(normalize_state(None), "unknown")


class ListAgentsTest(unittest.TestCase):
    def test_reads_the_cli_envelope(self):
        agents = list_agents(run=canned(LIVE_FIXTURE))
        self.assertEqual([a["pane_id"] for a in agents], ["wA:p13", "w28:p3", "wA:p1X"])

    def test_reads_an_unwrapped_payload_too(self):
        agents = list_agents(run=canned({"agents": [{"pane_id": "wA:p1"}]}))
        self.assertEqual(agents, [{"pane_id": "wA:p1"}])

    def test_non_json_output_is_unavailable(self):
        with self.assertRaises(HerdrUnavailable):
            list_agents(run=lambda args, timeout: "herdr: connection refused")

    def test_missing_agents_array_is_unavailable(self):
        with self.assertRaises(HerdrUnavailable):
            list_agents(run=canned({"result": {"type": "agent_list"}}))


class RunHerdrTest(unittest.TestCase):
    """The subprocess seam: every way herdr can fail becomes one exception."""

    def run_with(self, runner):
        return run_herdr(["herdr", "agent", "list"], 3.0, runner=runner)

    def test_missing_binary_is_unavailable(self):
        def missing(args, **kwargs):
            raise FileNotFoundError(args[0])

        with self.assertRaises(HerdrUnavailable):
            self.run_with(missing)

    def test_timeout_is_unavailable(self):
        def hangs(args, **kwargs):
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        with self.assertRaises(HerdrUnavailable) as caught:
            self.run_with(hangs)
        self.assertIn("timed out", str(caught.exception))

    def test_non_zero_exit_is_unavailable(self):
        def fails(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, "", "no herdr server\n")

        with self.assertRaises(HerdrUnavailable) as caught:
            self.run_with(fails)
        self.assertIn("no herdr server", str(caught.exception))

    def test_success_returns_stdout(self):
        def ok(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, '{"agents":[]}', "")

        self.assertEqual(self.run_with(ok), '{"agents":[]}')


class PanesByPeerKeyTest(unittest.TestCase):
    def test_keys_panes_by_the_advertised_project_and_name(self):
        panes = panes_by_peer_key(run=canned(LIVE_FIXTURE))
        self.assertEqual(
            sorted(panes),
            [("agent-fleet", "orchestrator"), ("agent-fleet", "reviewer")],
        )
        row = panes[("agent-fleet", "orchestrator")]
        self.assertEqual(row["state"], "working")
        self.assertEqual(row["pane_id"], "wA:p13")
        self.assertEqual(row["agent"], "pi")
        self.assertIs(row["focused"], True)
        self.assertEqual(panes[("agent-fleet", "reviewer")]["state"], "blocked")

    def test_the_same_name_in_two_projects_stays_two_panes(self):
        payload = {"agents": [
            {"pane_id": "wA:p1", "agent_status": "working", "tokens": {"coms": "orchestrator", "proj": "default"}},
            {"pane_id": "wA:p2", "agent_status": "idle", "tokens": {"coms": "orchestrator", "proj": "test-project"}},
        ]}
        panes = panes_by_peer_key(run=canned(payload))
        self.assertEqual(panes[("default", "orchestrator")]["state"], "working")
        self.assertEqual(panes[("test-project", "orchestrator")]["state"], "idle")

    def test_panes_without_a_peer_annotation_are_dropped(self):
        panes = panes_by_peer_key(run=canned(LIVE_FIXTURE))
        self.assertNotIn("wA:p1X", [pane.get("pane_id") for pane in panes.values()])

    def test_two_panes_claiming_one_key_collapse_to_ambiguous(self):
        payload = {"agents": [
            {"pane_id": "wA:p1", "agent_status": "working", "tokens": {"coms": "reviewer", "proj": "af"}},
            {"pane_id": "wA:p2", "agent_status": "idle", "tokens": {"coms": "reviewer", "proj": "af"}},
        ]}
        panes = panes_by_peer_key(run=canned(payload))
        self.assertEqual(panes[("af", "reviewer")], {"state": "unknown", "ambiguous": True})

    def test_pane_identity_beyond_the_allowlist_is_not_carried(self):
        panes = panes_by_peer_key(run=canned(LIVE_FIXTURE))
        row = panes[("agent-fleet", "orchestrator")]
        self.assertNotIn("terminal_id", row)
        self.assertNotIn("cwd", row)
        self.assertNotIn("tokens", row)


class VersionTest(unittest.TestCase):
    def test_reports_the_first_line(self):
        self.assertEqual(herdr_version(run=lambda args, timeout: "herdr 0.7.4\n"), "herdr 0.7.4")

    def test_absent_herdr_reports_no_version_instead_of_raising(self):
        def missing(args, timeout):
            raise HerdrUnavailable("herdr not found on PATH")

        self.assertIsNone(herdr_version(run=missing))


if __name__ == "__main__":
    unittest.main()
