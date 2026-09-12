"""
Local runtime evidence for the shipped watcher against a disposable Hub UDS.

Boundary: everything here is `synthetic-local`. The endpoint is a disposable
Unix domain socket under a temporary runtime root created by this test, Gate O
is absent, and the recovery transaction is driven by the test rather than by a
live Hermes. Nothing below proves Gate O, live origin delivery, steering,
surgical runtime use, or A6.
"""
import json
import os
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/hub-watchdog/scripts'))

from watchdog import run_watch, safe_invocation  # noqa: E402
from watchdog_delivery import deliver, delivery_state  # noqa: E402
from watchdog_recovery import recover  # noqa: E402
from watchdog_transport import MonitorTransport, TransportError, discover  # noqa: E402

PROFILE_ID = 'scenario'
HUB_INSTANCE_ID = 'hub'
PROFILE_KEY = 'a1' * 32
HUB_KEY = 'b2' * 32
OWNER = 'owner-1'


def _now():
    return datetime.now(timezone.utc)


class DisposableHub:
    """
    A real UDS server speaking the documented newline-JSON monitor protocol,
    laid out exactly as the registry does so the shipped discovery code applies.
    """

    def __init__(self, root):
        self.root = Path(root)
        self.calls = []
        self.tasks = [{'id': 'task-1', 'generation': 1, 'state': 'running', 'ownerSessionId': OWNER}]
        self.events = [self._event(1, 'task-1', 'running'), self._event(2, 'task-1', 'blocked')]
        self.invoke_result = {'status': 'accepted'}
        self.cancel_result = {'cancelled': True, 'state': 'cancelled'}
        self.token = 'secret-token-value'
        self._server = None
        self._thread = None

    @staticmethod
    def _event(sequence, task_id, to_state):
        return {
            'schema': 'agent-fleet.monitor-event', 'schemaVersion': 1,
            'eventId': f'hub:{sequence}', 'eventSequence': sequence,
            'profileKey': f'sha256:{PROFILE_KEY}', 'hubInstanceId': HUB_INSTANCE_ID, 'ownerId': OWNER,
            'occurredAt': _now().isoformat().replace('+00:00', 'Z'),
            'kind': 'task.state_changed',
            'task': {'id': task_id, 'generation': 1, 'toState': to_state, 'outputSequence': sequence},
            'materialKey': f'task:{task_id}:1:{to_state}',
        }

    # ── registry-shaped layout ───────────────────────────────────────────────
    def start(self):
        os.chmod(self.root, 0o700)
        namespace = self.root / PROFILE_KEY / HUB_KEY
        namespace.mkdir(parents=True)
        os.chmod(self.root / PROFILE_KEY, 0o700)
        os.chmod(namespace, 0o700)
        socket_dir = self.root / 's' / ('c3' * 16)
        socket_dir.mkdir(parents=True)
        self.socket_path = socket_dir / 's'

        token_file = namespace / f'token-{OWNER}'
        token_file.write_text(self.token)
        token_file.chmod(0o600)
        discovery = namespace / f'discovery-{OWNER}.json'
        discovery.write_text(json.dumps({
            'owner': OWNER,
            'socket': f'@runtime/s/{socket_dir.name}/s',
            'token': token_file.name,
            'lease': {'hub': HUB_INSTANCE_ID, 'expiresAt': (_now() + timedelta(minutes=10)).isoformat()},
        }))
        discovery.chmod(0o600)

        hub = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                data = b''
                while not data.endswith(b'\n'):
                    chunk = self.request.recv(4096)
                    if not chunk:
                        return
                    data += chunk
                self.request.sendall(json.dumps(hub.respond(json.loads(data))).encode() + b'\n')

        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
            allow_reuse_address = True

        self._server = Server(str(self.socket_path), Handler)
        os.chmod(self.socket_path, 0o600)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    # ── protocol ─────────────────────────────────────────────────────────────
    def respond(self, request):
        kind = request.get('type')
        if request.get('token') != self.token:
            return {'ok': False, 'error': 'unauthorized'}
        self.calls.append((kind, request.get('taskId'), request.get('generation')))
        if kind == 'events':
            after = request.get('afterSequence', 0)
            items = [event for event in self.events if event['eventSequence'] > after]
            first = self.events[0]['eventSequence'] if self.events else after + 1
            if after < first - 1:
                return {'ok': False, 'error': 'cursor_too_old'}
            latest = self.events[-1]['eventSequence'] if self.events else after
            return {'ok': True, 'events': {'firstAvailableSequence': first, 'latestSequence': latest, 'items': items}}
        if kind == 'snapshot':
            return {'ok': True, 'snapshot': {'tasks': self.tasks}}
        if kind == 'invoke':
            return {'ok': True, 'result': self.invoke_result}
        if kind == 'cancel':
            return {'ok': True, 'result': self.cancel_result}
        return {'ok': False, 'error': 'unsupported'}

    @property
    def transport_calls(self):
        return [call[0] for call in self.calls]


class RealTransport(MonitorTransport):
    """The shipped transport, unwrapping the `result` envelope like the socket does."""

    def invoke(self, payload):
        return self._call({**payload, 'type': 'invoke'}).get('result')

    def cancel(self, task_id, generation):
        return self._call({'type': 'cancel', 'taskId': task_id, 'generation': generation}).get('result')

    def invoke_recovery(self, task_id, generation):
        return self.invoke({'requestId': f'recovery:{task_id}:{generation}', 'taskId': task_id,
                            'generation': generation, 'action': 'request_status', 'parameters': {},
                            'basis': {'deviation': 'stalled_progress', 'judgment': 'confirmed'}})


class DisposableHubTestCase(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.state = self.root / 'state'
        self.lock = self.root / 'lock'
        for directory in (self.state, self.lock):
            directory.mkdir(mode=0o700)
        self.hub = DisposableHub(self.root).start()
        self.addCleanup(self._temporary.cleanup)
        self.addCleanup(self.hub.stop)

    def invocation(self, **overrides):
        base = {'profileId': PROFILE_ID, 'profileKey': PROFILE_KEY, 'hubKey': HUB_KEY,
                'hubInstanceId': HUB_INSTANCE_ID, 'runtimeDir': str(self.root),
                'stateDir': str(self.state), 'lockDir': str(self.lock)}
        base.update(overrides)
        return base

    def transport(self):
        return RealTransport(discover(str(self.root), PROFILE_KEY, HUB_KEY, _now()))

    def audit_rows(self):
        import hashlib
        path = (self.state / 'agent-fleet/hermes-watchdog'
                / hashlib.sha256(PROFILE_ID.encode()).hexdigest() / 'audit.ndjson')
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line]


class WatcherAgainstDisposableHub(DisposableHubTestCase):
    def test_discovery_authenticates_and_exposes_only_validated_identity(self):
        transport = self.transport()

        self.assertEqual(transport.owner, OWNER)
        self.assertEqual(transport.profile_key, PROFILE_KEY)
        self.assertEqual(transport.hub_instance_id, HUB_INSTANCE_ID)
        self.assertEqual(stat.S_IMODE(self.hub.socket_path.stat().st_mode), 0o600)

    def test_a_wrong_token_is_refused_by_the_real_socket(self):
        transport = self.transport()
        transport._token = 'not-the-token'

        with self.assertRaises(TransportError):
            transport.snapshot()

    def test_one_foreground_pass_consumes_real_events_and_releases_the_lock(self):
        result = run_watch(self.invocation(), 'observe', once=True)

        self.assertFalse(result['offline'], 'the watcher reached the disposable Hub')
        self.assertEqual(result['cursor'], 2)
        self.assertEqual(result['autonomy'], 'observe')
        self.assertEqual(list(self.lock.rglob('watch.lock')), [], 'the foreground lock is released on exit')

    def test_observe_mode_journals_without_invoking_or_cancelling(self):
        run_watch(self.invocation(), 'observe', once=True)

        decisions = [row['decision'] for row in self.audit_rows()]

        self.assertIn('material_event', decisions)
        self.assertNotIn('invoke_proposed', decisions)
        self.assertNotIn('recovery_proposed', decisions)
        self.assertEqual(self.hub.transport_calls, ['events'], 'observe reads events and nothing else')

    def test_a_second_consumer_keeps_its_own_cursor(self):
        run_watch(self.invocation(), 'observe', once=True)
        independent = self.transport()

        replay = independent.events(0)

        self.assertEqual([item['eventSequence'] for item in replay['items']], [1, 2])

    def test_a_retention_gap_falls_back_to_a_snapshot(self):
        self.hub.events = [self.hub._event(9, 'task-1', 'blocked')]

        result = run_watch(self.invocation(), 'observe', once=True)

        self.assertFalse(result['offline'])
        self.assertIn('snapshot', self.hub.transport_calls, 'the gap forced a snapshot reconciliation')
        self.assertIn('snapshot_reconciled', [row['decision'] for row in self.audit_rows()])

    def test_a_stopped_hub_journals_offline_without_escalating(self):
        self.hub.stop()

        result = run_watch(self.invocation(), 'observe', once=True)

        self.assertTrue(result['offline'])
        self.assertEqual([row['decision'] for row in self.audit_rows()], ['offline'])
        self.assertEqual(list(self.lock.rglob('watch.lock')), [])

    def test_a_second_watcher_cannot_take_the_same_profile_lock(self):
        lock_path = self.lock / 'agent-fleet-hermes-watchdog'
        import hashlib
        held = lock_path / hashlib.sha256(PROFILE_ID.encode()).hexdigest()
        held.mkdir(mode=0o700, parents=True)
        (held / 'watch.lock').write_text(str(os.getpid()))

        with self.assertRaises(ValueError) as caught:
            run_watch(self.invocation(), 'observe', once=True)

        self.assertEqual(str(caught.exception), 'watcher_locked')


class SyntheticLocalRecovery(DisposableHubTestCase):
    """
    Recovery mechanics driven over the real transport against the disposable
    local endpoint. Explicitly `synthetic-local`: the driver is this test, not a
    live Hermes, and it proves neither Gate O nor live delivery.
    """

    def transaction(self, **overrides):
        base = {'taskId': 'task-1', 'generation': 1, 'kind': 'native',
                'profileKey': PROFILE_KEY, 'ownerSessionId': OWNER, 'hubInstanceId': HUB_INSTANCE_ID}
        base.update(overrides)
        return base

    def test_exact_generation_cancel_then_one_recovery_enqueue(self):
        transport = self.transport()
        records = []

        tx = recover(self.transaction(), transport, ['task-1'], True, now=0, persist=records.append)
        self.assertEqual(tx['state'], 'cancelling')

        self.hub.tasks = [{'id': 'task-1', 'generation': 1, 'state': 'cancelled', 'ownerSessionId': OWNER}]
        tx = recover(tx, transport, ['task-1'], True, now=1, persist=records.append)
        self.assertEqual(tx['state'], 'cancel_observed')

        tx = recover(tx, transport, ['task-1'], True, now=2, persist=records.append)
        self.assertEqual(tx['state'], 'recovery_queued')

        self.assertEqual(records[0]['decision'], 'recovery_proposed')
        self.assertEqual(self.hub.transport_calls,
                         ['snapshot', 'cancel', 'snapshot', 'snapshot', 'invoke'])
        self.assertEqual([call for call in self.hub.calls if call[0] == 'cancel'], [('cancel', 'task-1', 1)])
        self.assertEqual(self.hub.transport_calls.count('invoke'), 1)

    def test_an_n_plus_one_generation_blocks_recovery_over_the_real_transport(self):
        transport = self.transport()
        self.hub.tasks = [
            {'id': 'task-1', 'generation': 1, 'state': 'running', 'ownerSessionId': OWNER},
            {'id': 'task-1', 'generation': 2, 'state': 'running', 'ownerSessionId': OWNER},
        ]

        tx = recover(self.transaction(), transport, ['task-1'], True, now=0, persist=lambda _row: None)

        self.assertEqual(tx['state'], 'superseded')
        self.assertNotIn('cancel', self.hub.transport_calls)
        self.assertNotIn('invoke', self.hub.transport_calls)

    def test_a_coms_transaction_is_refused_before_any_transport_call(self):
        transport = self.transport()

        tx = recover(self.transaction(kind='coms'), transport, ['task-1'], True, persist=lambda _row: None)

        self.assertEqual(tx['state'], 'refused')
        self.assertEqual(self.hub.calls, [], 'coms is wait-only: no cancel, no recovery, no transport')


class GateOStaysClosed(unittest.TestCase):
    def test_an_absent_gate_o_artifact_leaves_delivery_disabled(self):
        state = delivery_state(None)

        self.assertFalse(state['originDelivery'])
        self.assertEqual(state['disposition'], 'journal-only-no-steering')

    def test_a_synthetic_artifact_cannot_unlock_delivery(self):
        synthetic = {'artifactValid': True, 'originDelivery': True, 'liveRunId': 'local',
                     'synthetic': True, 'api': {'name': 'fake'},
                     'observations': {'opaqueOrigin': True, 'threeIncrementalUpdates': True,
                                      'twoChatIsolation': True, 'wakeReconnect': True,
                                      'profileIsolation': True, 'structuredInvocation': True},
                     'evidenceIds': ['x']}

        self.assertFalse(delivery_state(synthetic)['originDelivery'])
        with self.assertRaises(RuntimeError):
            deliver(synthetic, {'channel': 'c', 'chatId': 'x', 'sessionId': 's'}, 'message', lambda *_: True)

    def test_a_closed_gate_lowers_a_requested_steering_tier_to_observe(self):
        _value, level = safe_invocation('{"autonomy":"steer","maximumAutonomy":"steer"}')

        self.assertEqual(level, 'observe')


if __name__ == '__main__':
    unittest.main()
