"""Slice 1 — coms registry reader. No Hermes, no herdr, no ~/.pi.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/coms-registry.test.py
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coms_registry import (  # noqa: E402
    RegistryUnavailable,
    entry_is_live,
    heartbeat_is_fresh,
    live_sessions_by_project,
    pid_is_alive,
)

NOW = datetime(2026, 7, 26, 21, 0, 0, tzinfo=timezone.utc)
NOW_MS = NOW.timestamp() * 1000

# The real record shape, copied from ~/.pi/coms/projects/*/agents/*.json. The
# fixture is the contract check against scripts/lib/coms-envelope.ts.
ENTRY = {
    "session_id": "01KYCQR3VF4674CF0MPQV2DJYS",
    "name": "orchestrator",
    "purpose": "Verification-Contract orchestrator",
    "model": "minimax-m3:cloud",
    "color": "#FFAA8B",
    "pid": 4164891,
    "endpoint": "/home/nchankov/.pi/coms/sockets/01KYCQR3VF4674CF0MPQV2DJYS.sock",
    "cwd": "/home/nchankov/repos/agent-fleet",
    "started_at": "2026-07-26T14:19:35.944Z",
    "explicit": False,
    "version": 1,
    "context_used_pct": 12,
    "queue_depth": 0,
    "heartbeat_at": "2026-07-26T20:59:40.000Z",
}


def stamp(offset_seconds: float) -> str:
    return (NOW + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")


def write_entry(root: Path, project: str, overrides: dict) -> Path:
    entry = {**ENTRY, **overrides}
    agents = root / project / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / f"{entry['name']}.json"
    path.write_text(json.dumps(entry), encoding="utf-8")
    return path


class HeartbeatTest(unittest.TestCase):
    def test_fresh_heartbeat_within_the_90s_window(self):
        self.assertTrue(heartbeat_is_fresh({"heartbeat_at": stamp(-89)}, NOW_MS))

    def test_stale_heartbeat_outside_the_window(self):
        self.assertFalse(heartbeat_is_fresh({"heartbeat_at": stamp(-91)}, NOW_MS))

    def test_small_clock_skew_into_the_future_is_tolerated(self):
        self.assertTrue(heartbeat_is_fresh({"heartbeat_at": stamp(4)}, NOW_MS))
        self.assertFalse(heartbeat_is_fresh({"heartbeat_at": stamp(6)}, NOW_MS))

    def test_missing_or_malformed_heartbeat_is_not_fresh(self):
        self.assertFalse(heartbeat_is_fresh({}, NOW_MS))
        self.assertFalse(heartbeat_is_fresh({"heartbeat_at": "yesterday"}, NOW_MS))


class LivenessTest(unittest.TestCase):
    def test_stale_heartbeat_falls_back_to_the_pid_probe(self):
        entry = {"heartbeat_at": stamp(-3600), "pid": 4242}
        self.assertTrue(entry_is_live(entry, NOW_MS, pid_probe=lambda pid: pid == 4242))
        self.assertFalse(entry_is_live(entry, NOW_MS, pid_probe=lambda pid: False))

    def test_fresh_heartbeat_wins_before_the_pid_probe(self):
        def explode(pid):
            raise AssertionError("pid probe must not run for a fresh heartbeat")

        self.assertTrue(entry_is_live({"heartbeat_at": stamp(-1), "pid": 1}, NOW_MS, pid_probe=explode))

    def test_own_pid_is_alive_and_a_bogus_pid_is_not(self):
        self.assertTrue(pid_is_alive(os.getpid()))
        self.assertFalse(pid_is_alive(None))
        self.assertFalse(pid_is_alive(0))
        self.assertFalse(pid_is_alive(-1))


class ScanTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def scan(self, **kwargs):
        return live_sessions_by_project(self.root, now_ms=NOW_MS, **kwargs)

    def test_groups_live_sessions_by_project_directory(self):
        write_entry(self.root, "alpha", {"name": "orchestrator"})
        write_entry(self.root, "alpha", {"name": "reviewer"})
        write_entry(self.root, "beta", {"name": "documenter"})
        result = self.scan(pid_probe=lambda pid: True)
        self.assertEqual(sorted(result), ["alpha", "beta"])
        self.assertEqual([e["name"] for e in result["alpha"]], ["orchestrator", "reviewer"])

    def test_dead_sessions_and_empty_projects_produce_no_rows(self):
        write_entry(self.root, "alpha", {"name": "ghost", "heartbeat_at": stamp(-3600)})
        (self.root / "historical" / "agents").mkdir(parents=True)
        self.assertEqual(self.scan(pid_probe=lambda pid: False), {})

    def test_broken_json_is_skipped_not_fatal(self):
        write_entry(self.root, "alpha", {"name": "good"})
        (self.root / "alpha" / "agents" / "half-written.json").write_text('{"name": "tru', encoding="utf-8")
        result = self.scan(pid_probe=lambda pid: True)
        self.assertEqual([e["name"] for e in result["alpha"]], ["good"])

    def test_unknown_schema_version_fails_loudly(self):
        write_entry(self.root, "alpha", {"name": "future", "version": 2})
        with self.assertRaises(RegistryUnavailable) as caught:
            self.scan(pid_probe=lambda pid: True)
        self.assertIn("version", str(caught.exception))

    def test_missing_registry_root_is_unavailable(self):
        with self.assertRaises(RegistryUnavailable):
            live_sessions_by_project(self.root / "nope", now_ms=NOW_MS)

    def test_reading_never_deletes_a_dead_record(self):
        path = write_entry(self.root, "alpha", {"name": "ghost", "heartbeat_at": stamp(-3600)})
        self.scan(pid_probe=lambda pid: False)
        self.assertTrue(path.exists(), "the plugin must never prune another process's files")


if __name__ == "__main__":
    unittest.main()
