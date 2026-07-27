"""Slice 4 — the write half, against a real unix socket speaking the envelope
protocol. No pi, no gateway: a fake peer that acks, nacks, or answers.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/coms-send.test.py
"""

import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coms_send import (  # noqa: E402
    ComsSendError,
    Dispatcher,
    resolve_endpoint,
    ulid,
    validate_name,
    validate_project,
)


def iso(offset_s: float = 0.0) -> str:
    stamp = datetime.now(timezone.utc) + timedelta(seconds=offset_s)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FakePeer:
    """A coms peer: reads one prompt, acks (or nacks), optionally answers."""

    def __init__(self, path: Path, *, nack: str | None = None, answer=None, answer_error=None):
        self.path = path
        self.nack = nack
        self.answer = answer
        self.answer_error = answer_error
        self.received: list[dict] = []
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen(4)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        self._server.settimeout(5.0)
        try:
            conn, _ = self._server.accept()
        except (socket.timeout, OSError):
            return
        with conn:
            data = conn.recv(65536).split(b"\n", 1)[0]
            envelope = json.loads(data)
            self.received.append(envelope)
            if self.nack:
                conn.sendall((json.dumps({"type": "nack", "msg_id": envelope["msg_id"], "error": self.nack}) + "\n").encode())
                return
            conn.sendall((json.dumps({"type": "ack", "msg_id": envelope["msg_id"]}) + "\n").encode())
        if self.answer is None and self.answer_error is None:
            return
        # Answer on the sender's reply socket, exactly as coms/index.ts does.
        reply = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        reply.settimeout(5.0)
        reply.connect(envelope["sender_endpoint"])
        with reply:
            reply.sendall((json.dumps({
                "type": "response",
                "msg_id": envelope["msg_id"],
                "sender_session": "01PEER",
                "sender_endpoint": str(self.path),
                "hops": 0,
                "timestamp": iso(),
                "response": self.answer,
                "error": self.answer_error,
            }) + "\n").encode())
            reply.recv(4096)  # the ack

    def close(self):
        try:
            self._server.close()
        except OSError:
            pass


class ValidationTest(unittest.TestCase):
    """Path components are validated before they are ever joined to a path."""

    def test_traversal_and_separators_are_refused(self):
        for bad in ("..", "../etc", "a/b", "a\\b", ".", ""):
            with self.assertRaises(ComsSendError):
                validate_project(bad)

    def test_reserved_and_malformed_names_are_refused(self):
        for bad in ("projects", "-leading", "with space", "a" * 65, ""):
            with self.assertRaises(ComsSendError):
                validate_name(bad)

    def test_ordinary_identifiers_pass(self):
        self.assertEqual(validate_project("agent-fleet.hermes-plugin"), "agent-fleet.hermes-plugin")
        self.assertEqual(validate_name("code-reviewer"), "code-reviewer")

    def test_ulid_is_26_crockford_chars(self):
        value = ulid()
        self.assertEqual(len(value), 26)
        self.assertRegex(value, r"^[0-9A-HJKMNP-TV-Z]{26}$")


class ResolveEndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write_entry(self, project, name, **overrides):
        agents = self.root / project / "agents"
        agents.mkdir(parents=True, exist_ok=True)
        entry = {
            "name": name,
            "endpoint": f"/tmp/{name}.sock",
            "pid": 1,
            "version": 1,
            "heartbeat_at": iso(),
            **overrides,
        }
        (agents / f"{name}.json").write_text(json.dumps(entry))

    def test_returns_the_registry_endpoint(self):
        self.write_entry("af", "reviewer")
        self.assertEqual(resolve_endpoint("af", "reviewer", self.root), "/tmp/reviewer.sock")

    def test_an_unknown_peer_is_refused_not_invented(self):
        with self.assertRaises(ComsSendError):
            resolve_endpoint("af", "ghost", self.root)

    def test_a_dead_peer_is_refused_even_though_its_file_is_there(self):
        # Stale heartbeat AND a pid that cannot be alive: the record outlived
        # the process, which is exactly the 3-second-old-snapshot case.
        self.write_entry("af", "zombie", heartbeat_at=iso(-600), pid=0)
        with self.assertRaises(ComsSendError) as caught:
            resolve_endpoint("af", "zombie", self.root)
        self.assertIn("no longer live", str(caught.exception))

    def test_a_peer_without_an_endpoint_is_refused(self):
        self.write_entry("af", "mute", endpoint="")
        with self.assertRaises(ComsSendError):
            resolve_endpoint("af", "mute", self.root)


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "projects"
        self.sockets = self.base / "sockets"
        self.sockets.mkdir(parents=True)
        self.addCleanup(self.tmp.cleanup)

    def peer(self, project, name, **kwargs):
        agents = self.root / project / "agents"
        agents.mkdir(parents=True, exist_ok=True)
        endpoint = self.base / f"{name}.sock"
        (agents / f"{name}.json").write_text(json.dumps({
            "name": name, "endpoint": str(endpoint), "pid": 1, "version": 1, "heartbeat_at": iso(),
        }))
        fake = FakePeer(endpoint, **kwargs)
        self.addCleanup(fake.close)
        return fake

    def wait_for(self, dispatcher, msg_id, status, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            row = next((r for r in dispatcher.recent() if r["msg_id"] == msg_id), None)
            if row and row["status"] == status:
                return row
            time.sleep(0.02)
        self.fail(f"{msg_id} never reached {status!r}: {dispatcher.recent()}")

    def test_the_prompt_reaches_the_peer_as_a_coms_envelope(self):
        peer = self.peer("af", "reviewer")
        dispatcher = Dispatcher(self.sockets)
        sent = dispatcher.dispatch("af", "reviewer", "count the files", root=self.root)

        self.assertEqual(sent["status"], "pending")
        envelope = peer.received[0]
        self.assertEqual(envelope["type"], "prompt")
        self.assertEqual(envelope["prompt"], "count the files")
        self.assertEqual(envelope["sender_name"], "hermes-panel")
        self.assertEqual(envelope["hops"], 0)
        self.assertEqual(envelope["msg_id"], sent["msg_id"])
        # The reply socket must exist by the time the prompt goes out, or a fast
        # peer answers into nothing.
        self.assertTrue(Path(envelope["sender_endpoint"]).exists())

    def test_an_answer_lands_against_its_own_dispatch(self):
        self.peer("af", "reviewer", answer="1408 files")
        dispatcher = Dispatcher(self.sockets)
        sent = dispatcher.dispatch("af", "reviewer", "count the files", root=self.root)
        row = self.wait_for(dispatcher, sent["msg_id"], "answered")
        self.assertEqual(row["response"], "1408 files")
        self.assertIsNotNone(row["answered_at"])

    def test_a_peer_error_is_kept_as_an_error_not_an_answer(self):
        self.peer("af", "reviewer", answer=None, answer_error="tool refused")
        dispatcher = Dispatcher(self.sockets)
        sent = dispatcher.dispatch("af", "reviewer", "do it", root=self.root)
        row = self.wait_for(dispatcher, sent["msg_id"], "error")
        self.assertEqual(row["detail"], "tool refused")

    def test_a_structured_answer_is_rendered_as_text(self):
        self.peer("af", "reviewer", answer={"files": 1408})
        dispatcher = Dispatcher(self.sockets)
        sent = dispatcher.dispatch("af", "reviewer", "count", root=self.root)
        row = self.wait_for(dispatcher, sent["msg_id"], "answered")
        self.assertIn('"files": 1408', row["response"])

    def test_a_nack_surfaces_the_peers_reason(self):
        self.peer("af", "reviewer", nack="hops exceeded")
        dispatcher = Dispatcher(self.sockets)
        with self.assertRaises(ComsSendError) as caught:
            dispatcher.dispatch("af", "reviewer", "go", root=self.root)
        self.assertIn("hops exceeded", str(caught.exception))

    def test_a_peer_that_is_not_listening_fails_the_dispatch(self):
        agents = self.root / "af" / "agents"
        agents.mkdir(parents=True)
        (agents / "ghost.json").write_text(json.dumps({
            "name": "ghost", "endpoint": str(self.base / "nothing.sock"),
            "pid": 1, "version": 1, "heartbeat_at": iso(),
        }))
        dispatcher = Dispatcher(self.sockets)
        with self.assertRaises(ComsSendError) as caught:
            dispatcher.dispatch("af", "ghost", "hello", root=self.root)
        self.assertIn("not listening", str(caught.exception))

    def test_two_outstanding_prompts_do_not_share_a_reply_socket(self):
        self.peer("af", "one", answer="from one")
        self.peer("af", "two", answer="from two")
        dispatcher = Dispatcher(self.sockets)
        first = dispatcher.dispatch("af", "one", "a", root=self.root)
        second = dispatcher.dispatch("af", "two", "b", root=self.root)
        self.assertEqual(self.wait_for(dispatcher, first["msg_id"], "answered")["response"], "from one")
        self.assertEqual(self.wait_for(dispatcher, second["msg_id"], "answered")["response"], "from two")

    def test_an_empty_prompt_is_refused_before_anything_is_opened(self):
        self.peer("af", "reviewer")
        dispatcher = Dispatcher(self.sockets)
        with self.assertRaises(ComsSendError):
            dispatcher.dispatch("af", "reviewer", "   ", root=self.root)
        self.assertEqual(list(self.sockets.iterdir()), [])

    def test_the_transcript_is_bounded_and_newest_first(self):
        self.peer("af", "reviewer")
        dispatcher = Dispatcher(self.sockets)
        dispatcher._tracked = {f"M{i}": {
            "msg_id": f"M{i}", "project": "af", "name": "r", "prompt": "p",
            "sent_at": iso(), "status": "pending", "detail": None,
            "response": None, "answered_at": None,
        } for i in range(5)}
        self.assertEqual([row["msg_id"] for row in dispatcher.recent(3)], ["M4", "M3", "M2"])

    def test_a_long_answer_is_clipped_for_a_300px_pane(self):
        dispatcher = Dispatcher(self.sockets)
        dispatcher._tracked = {"M": {
            "msg_id": "M", "project": "af", "name": "r", "prompt": "x" * 500,
            "sent_at": iso(), "status": "answered", "detail": None,
            "response": "y" * 5000, "answered_at": iso(),
        }}
        row = dispatcher.recent()[0]
        self.assertEqual(len(row["prompt"]), 200)
        self.assertEqual(len(row["response"]), 2000)

    def test_a_timed_out_dispatch_cleans_up_its_socket(self):
        peer = self.peer("af", "reviewer")
        dispatcher = Dispatcher(self.sockets, ttl_s=0.2)
        sent = dispatcher.dispatch("af", "reviewer", "silence", root=self.root)
        self.wait_for(dispatcher, sent["msg_id"], "timeout")
        self.assertFalse(Path(peer.received[0]["sender_endpoint"]).exists())


if __name__ == "__main__":
    unittest.main()
