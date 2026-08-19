"""Discovery/Gate O contracts and the identity a transport is allowed to expose."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/hub-watchdog/scripts'))

from watchdog_actions import transport_identity  # noqa: E402
from watchdog_contract import gate_o_valid, validate_discovery  # noqa: E402
from watchdog_transport import MAX_RESPONSE, MonitorTransport, TransportError, discover, reconcile  # noqa: E402

PROFILE_KEY = 'a' * 64
HUB_KEY = 'b' * 64
HUB_ID = 'hub-instance-1'

COMPLETE_GATE_O = {
    # artifactValid is deliberately omitted: Python independently verifies every semantic field.
    'originDelivery': True,
    'liveRunId': 'disposable-live-run',
    'api': {'kind': 'argv', 'name': 'hermes origin-update', 'argumentShape': '[opaque-route] [message]'},
    'observations': {
        'opaqueOrigin': True, 'threeIncrementalUpdates': True, 'twoChatIsolation': True,
        'wakeReconnect': True, 'profileIsolation': True, 'structuredInvocation': True,
    },
    'evidenceIds': ['sanitized-a', 'sanitized-b'],
}


def future(minutes=10):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def discovery_document(**overrides):
    base = {'owner': 'owner-1', 'socket': '@runtime/s/abc/s', 'token': 'token-file',
            'lease': {'hub': HUB_ID, 'expiresAt': future()}}
    base.update(overrides)
    return base


class GateOContract(unittest.TestCase):
    def test_an_incomplete_artifact_is_never_valid(self):
        self.assertFalse(gate_o_valid({'artifactValid': True, 'originDelivery': True}))
        self.assertFalse(gate_o_valid({}))
        self.assertFalse(gate_o_valid(None))

    def test_a_complete_artifact_is_valid_but_a_synthetic_one_is_not(self):
        self.assertTrue(gate_o_valid(COMPLETE_GATE_O))
        self.assertFalse(gate_o_valid({**COMPLETE_GATE_O, 'synthetic': True}))

    def test_self_declared_validity_unsupported_and_explicit_target_never_unlock_gate_o(self):
        self.assertFalse(gate_o_valid({'artifactValid': True, 'originDelivery': True}))
        self.assertFalse(gate_o_valid({**COMPLETE_GATE_O, 'unsupported': True}))
        self.assertFalse(gate_o_valid({**COMPLETE_GATE_O, 'api': {**COMPLETE_GATE_O['api'], 'name': 'hermes send --to opaque'}}))
        self.assertFalse(gate_o_valid({**COMPLETE_GATE_O, 'evidenceIds': ['only-one']}))

    def test_every_required_observation_is_load_bearing(self):
        for key in COMPLETE_GATE_O['observations']:
            observations = {**COMPLETE_GATE_O['observations'], key: False}

            self.assertFalse(gate_o_valid({**COMPLETE_GATE_O, 'observations': observations}), key)

    def test_shared_gate_o_fixture_matrix_has_zero_python_permissive_cases(self):
        root = Path(__file__).parents[2]
        matrix = json.loads((root / 'hermes/gates/gate-o-validator-fixtures.json').read_text())
        unsafe = [fixture for fixture in matrix if not fixture['originDelivery']]
        self.assertEqual(len(unsafe), 365, '8 markers × 9 separators × 5 fields plus 5 target-only send --to spacings')
        self.assertEqual({fixture['field'] for fixture in unsafe}, {'api.kind', 'api.name', 'api.argumentShape', 'evidenceIds', 'liveRunId'})
        for fixture in matrix:
            artifact = fixture['artifact']
            result = subprocess.run(['node', 'scripts/hermes-watchdog-capability-probe.ts'], input=json.dumps(artifact), text=True,
                                    cwd=root, capture_output=True, check=True)
            self.assertEqual(gate_o_valid(artifact), fixture['originDelivery'], fixture['name'])
            self.assertEqual(json.loads(result.stdout)['originDelivery'], fixture['originDelivery'], fixture['name'])


class DiscoveryContract(unittest.TestCase):
    def test_a_valid_document_round_trips(self):
        value = validate_discovery('.', discovery_document(), datetime.now(timezone.utc))

        self.assertEqual(value['lease']['hub'], HUB_ID)

    def test_expired_or_malformed_documents_are_rejected(self):
        cases = {
            'expired': discovery_document(lease={'hub': HUB_ID, 'expiresAt': '1970-01-01T00:00:00Z'}),
            'no owner': discovery_document(owner=''),
            'foreign socket': discovery_document(socket='/tmp/evil.sock'),
            'unprefixed token': discovery_document(token='plain'),
            'no hub': discovery_document(lease={'expiresAt': future()}),
            'extra key': {**discovery_document(), 'extra': 1},
        }
        for label, document in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                validate_discovery('.', document, datetime.now(timezone.utc))


class TransportIdentity(unittest.TestCase):
    def test_discovery_supplies_profile_hub_and_owner_identity(self):
        transport = MonitorTransport({**discovery_document(), 'socketPath': '/tmp/none.sock',
                                      'token': 'token-value', 'profileKey': PROFILE_KEY})

        self.assertEqual(transport_identity(transport), {
            'profileKey': PROFILE_KEY, 'ownerSessionId': 'owner-1', 'hubInstanceId': HUB_ID,
        })

    def test_the_token_is_retained_in_memory_and_not_a_public_attribute(self):
        transport = MonitorTransport({**discovery_document(), 'socketPath': '/tmp/none.sock',
                                      'token': 'token-value', 'profileKey': PROFILE_KEY})

        public = {name: value for name, value in vars(transport).items() if not name.startswith('_')}

        self.assertNotIn('token-value', repr(public))
        self.assertEqual(transport._token, 'token-value')

    def test_identity_of_a_transport_without_discovery_is_all_missing(self):
        class Bare:
            pass

        self.assertEqual(transport_identity(Bare()), {'profileKey': None, 'ownerSessionId': None, 'hubInstanceId': None})

    def test_a_long_poll_read_timeout_covers_the_wait_window_it_requests(self):
        transport = MonitorTransport({**discovery_document(), 'socketPath': '/tmp/none.sock',
                                      'token': 'token-value', 'profileKey': PROFILE_KEY}, timeout=5)
        seen = {}

        def capture(payload, timeout=None):
            seen['payload'] = payload
            seen['timeout'] = timeout
            return {'events': {'items': []}}

        transport._call = capture
        transport.events(0)

        # A read timeout shorter than the requested wait would expire locally on
        # every quiet poll and be journaled as an outage.
        self.assertGreater(seen['timeout'], seen['payload']['waitMs'] / 1000)
        self.assertLessEqual(seen['payload']['waitMs'], 25000)


class DiscoveryDirectory(unittest.TestCase):
    def _namespace(self, root):
        namespace = Path(root) / PROFILE_KEY / HUB_KEY
        namespace.mkdir(parents=True)
        os.chmod(root, 0o700)
        os.chmod(Path(root) / PROFILE_KEY, 0o700)
        os.chmod(namespace, 0o700)
        return namespace

    def test_a_non_hex_key_is_refused_before_any_filesystem_read(self):
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root, 0o700)

            with self.assertRaises(TransportError) as caught:
                discover(root, 'not-hex', HUB_KEY, datetime.now(timezone.utc))

            self.assertEqual(str(caught.exception), 'discovery')

    def test_a_world_readable_runtime_root_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root, 0o755)

            with self.assertRaises(TransportError) as caught:
                discover(root, PROFILE_KEY, HUB_KEY, datetime.now(timezone.utc))

            self.assertEqual(str(caught.exception), 'unsafe_runtime')

    def test_more_than_one_discovery_entry_is_ambiguous_and_refused(self):
        with tempfile.TemporaryDirectory() as root:
            namespace = self._namespace(root)
            for index in (1, 2):
                path = namespace / f'discovery-{index}.json'
                path.write_text(json.dumps(discovery_document()))
                path.chmod(0o600)

            with self.assertRaises(TransportError):
                discover(root, PROFILE_KEY, HUB_KEY, datetime.now(timezone.utc))

    def test_a_valid_namespace_yields_identity_without_leaking_the_token_path(self):
        with tempfile.TemporaryDirectory() as root:
            namespace = self._namespace(root)
            socket_dir = Path(root) / 's' / 'abc'
            socket_dir.mkdir(parents=True)
            document = discovery_document(socket='@runtime/s/abc/s')
            entry = namespace / 'discovery-1.json'
            entry.write_text(json.dumps(document))
            entry.chmod(0o600)
            token_file = namespace / document['token']
            token_file.write_text('secret-token\n')
            token_file.chmod(0o600)

            value = discover(root, PROFILE_KEY, HUB_KEY, datetime.now(timezone.utc))

            self.assertEqual(value['profileKey'], PROFILE_KEY)
            self.assertEqual(value['hubKey'], HUB_KEY)
            self.assertEqual(value['token'], 'secret-token')
            self.assertEqual(value['socketPath'], str(socket_dir / 's'))
            self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)

    def test_a_world_readable_token_file_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            namespace = self._namespace(root)
            (Path(root) / 's' / 'abc').mkdir(parents=True)
            document = discovery_document()
            entry = namespace / 'discovery-1.json'
            entry.write_text(json.dumps(document))
            entry.chmod(0o600)
            token_file = namespace / document['token']
            token_file.write_text('secret-token\n')
            token_file.chmod(0o644)

            with self.assertRaises(TransportError) as caught:
                discover(root, PROFILE_KEY, HUB_KEY, datetime.now(timezone.utc))

            self.assertEqual(str(caught.exception), 'unsafe_file')


class Reconciliation(unittest.TestCase):
    class Transport:
        def __init__(self, error=None):
            self.error = error
            self.calls = []

        def events(self, cursor):
            self.calls.append(('events', cursor))
            if self.error is not None:
                raise TransportError(self.error)
            return {'items': [], 'cursor': cursor}

        def snapshot(self):
            self.calls.append(('snapshot', None))
            return {'tasks': []}

    def test_a_retention_gap_falls_back_to_a_snapshot_and_resets_the_cursor(self):
        for error in ('cursor_too_old', 'owner_changed'):
            transport = self.Transport(error)

            batch = reconcile(transport, 42)

            self.assertTrue(batch['reconciled'], error)
            self.assertEqual(batch['cursor'], 0, error)
            self.assertEqual([call[0] for call in transport.calls], ['events', 'snapshot'], error)

    def test_an_unrelated_transport_error_is_raised_rather_than_masked(self):
        transport = self.Transport('offline')

        with self.assertRaises(TransportError):
            reconcile(transport, 42)

        self.assertEqual([call[0] for call in transport.calls], ['events'])

    def test_the_response_cap_stays_bounded(self):
        self.assertEqual(MAX_RESPONSE, 2 * 1024 * 1024)


if __name__ == '__main__':
    unittest.main()
