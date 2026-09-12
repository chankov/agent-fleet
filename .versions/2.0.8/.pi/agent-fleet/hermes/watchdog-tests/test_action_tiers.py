"""Typed invoke admission: identity, durability ordering, and zero-transport refusals."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/hub-watchdog/scripts'))

from watchdog_actions import admit, allow, request_digest  # noqa: E402

PROFILE_KEY = 'p' * 64
HUB_ID = 'hub-instance-1'
OWNER = 'owner-1'


class FakeTransport:
    """Records every call in one ordered ledger shared with the persist hook."""

    def __init__(self, ledger=None, rows=None, invoke_result=None, invoke_error=None):
        self.ledger = ledger if ledger is not None else []
        self.rows = rows if rows is not None else [{'generation': 1, 'state': 'running', 'ownerSessionId': OWNER}]
        self.invoke_result = invoke_result if invoke_result is not None else {'status': 'accepted'}
        self.invoke_error = invoke_error
        self.profile_key = PROFILE_KEY
        self.owner = OWNER
        self.hub_instance_id = HUB_ID

    def snapshot(self, task_id=None):
        self.ledger.append(('snapshot', task_id))
        return self.rows

    def invoke(self, request):
        self.ledger.append(('invoke', request['requestId']))
        if self.invoke_error is not None:
            raise self.invoke_error
        return self.invoke_result

    @property
    def transport_calls(self):
        return [entry for entry in self.ledger if entry[0] in ('snapshot', 'invoke')]


def gate_o(**overrides):
    base = {'originDelivery': True, 'liveRunId': 'disposable-live',
            'api': {'kind': 'argv', 'name': 'hermes origin-update', 'argumentShape': '[opaque-route] [message]'},
            'observations': {'opaqueOrigin': True, 'threeIncrementalUpdates': True, 'wakeReconnect': True,
                             'profileIsolation': True, 'twoChatIsolation': True, 'structuredInvocation': True},
            'evidenceIds': ['sanitized-a', 'sanitized-b']}
    base.update(overrides)
    return base


def config(**overrides):
    base = {'autonomy': 'steer', 'maximumAutonomy': 'steer', 'gateO': gate_o(),
            'profileKey': PROFILE_KEY, 'ownerSessionId': OWNER, 'hubInstanceId': HUB_ID}
    base.update(overrides)
    return base


def request(**overrides):
    base = {'requestId': 'event-1', 'action': 'request_status', 'taskId': 'task-1', 'generation': 1,
            'profileKey': PROFILE_KEY, 'ownerSessionId': OWNER, 'hubInstanceId': HUB_ID,
            'parameters': {'assertionIds': [], 'evidenceEventIds': ['hub:1'], 'instruction': 'Провери и докладвай.'},
            'basis': {'deviation': 'stalled_progress', 'judgment': 'confirmed'}}
    base.update(overrides)
    return base


def recorder(ledger):
    def persist(row):
        ledger.append(('persist', row['parametersDigest']))
    return persist


class AdmissionTiers(unittest.TestCase):
    def test_gate_and_tier_ceilings_block_admission(self):
        transport = FakeTransport()

        self.assertFalse(allow(config(autonomy='observe'), request(), transport))
        self.assertFalse(allow(config(autonomy='shadow'), request(), transport))
        self.assertFalse(allow(config(maximumAutonomy='observe'), request(), transport))
        self.assertFalse(allow(config(gateO=False), request(), transport))
        self.assertFalse(allow(config(gateO={'artifactValid': True, 'originDelivery': True}), request(), transport))
        self.assertFalse(allow(config(gateO=gate_o(unsupported=True)), request(), transport))
        self.assertFalse(allow(config(), request(), transport, online=False))
        self.assertTrue(allow(config(), request(), transport))

    def test_observe_and_shadow_make_zero_transport_calls(self):
        for autonomy in ('observe', 'shadow'):
            ledger = []
            transport = FakeTransport(ledger)

            result = admit(config(autonomy=autonomy), request(), transport, persist=recorder(ledger))

            self.assertEqual(result, {'status': 'refused'})
            self.assertEqual(ledger, [], 'a refused tier neither persists nor transports')

    def test_only_closed_typed_actions_are_admitted(self):
        transport = FakeTransport()

        for deviation, action in (('stalled_progress', 'request_status'), ('verification_gap', 'request_verification'),
                                  ('scope_drift', 'narrow_scope'), ('research_gap', 'request_research'),
                                  ('repeated_failure', 'request_specialist')):
            self.assertTrue(allow(config(), request(action=action, basis={'deviation': deviation}), transport), action)
        for action in ('shell', 'dispatch_agent', 'send', 'none', '', None, 42):
            self.assertFalse(allow(config(), request(action=action), transport), repr(action))
        self.assertFalse(allow(config(), request(cancel=True), transport))

    def test_missing_or_mismatched_identity_is_refused(self):
        transport = FakeTransport()

        for key in ('profileKey', 'ownerSessionId', 'hubInstanceId'):
            self.assertFalse(allow(config(), request(**{key: 'forged'}), transport), f'forged request {key}')
            self.assertFalse(allow(config(), request(**{key: None}), transport), f'missing request {key}')
            self.assertFalse(allow(config(**{key: None}), request(), transport), f'missing config {key}')

    def test_a_forged_request_agreeing_with_a_forged_config_still_fails_against_discovery(self):
        transport = FakeTransport()
        forged = {'profileKey': 'q' * 64, 'ownerSessionId': 'other-owner', 'hubInstanceId': 'other-hub'}

        self.assertFalse(
            allow(config(**forged), request(**forged), transport),
            'identity must be validated against live discovery, not a self-consistent copy',
        )

    def test_invalid_task_generation_or_forbidden_authority_is_refused(self):
        transport = FakeTransport()

        self.assertFalse(allow(config(), request(taskId=''), transport))
        self.assertFalse(allow(config(), request(taskId=None), transport))
        self.assertFalse(allow(config(), request(generation=0), transport))
        self.assertFalse(allow(config(), request(generation='1'), transport))
        for key in ('token', 'origin', 'route', 'routeId', 'prompt', 'command', 'shell', 'herdr', 'tool'):
            self.assertFalse(allow(config(), request(**{key: 'x'}), transport), key)

    def test_digest_and_proposal_persist_before_the_first_transport_call(self):
        ledger = []
        transport = FakeTransport(ledger)

        result = admit(config(), request(), transport, persist=recorder(ledger))

        self.assertEqual(result, {'status': 'accepted'})
        self.assertEqual([entry[0] for entry in ledger], ['persist', 'snapshot', 'invoke'])
        self.assertEqual(ledger[0][1], request_digest(request()))

    def test_persistence_failure_refuses_with_zero_transport_calls(self):
        ledger = []
        transport = FakeTransport(ledger)

        def failing_persist(_row):
            raise OSError('disk full')

        result = admit(config(), request(), transport, persist=failing_persist)

        self.assertEqual(result, {'status': 'refused'})
        self.assertEqual(transport.transport_calls, [])

    def test_absent_persistence_hook_refuses(self):
        ledger = []
        transport = FakeTransport(ledger)

        self.assertEqual(admit(config(), request(), transport), {'status': 'refused'})
        self.assertEqual(transport.transport_calls, [])

    def test_stale_terminal_or_superseded_targets_are_refused_without_invoking(self):
        cases = {
            'terminal': [{'generation': 1, 'state': 'completed', 'ownerSessionId': OWNER}],
            'superseded': [{'generation': 2, 'state': 'running', 'ownerSessionId': OWNER}],
            'missing': [],
            'foreign_owner': [{'generation': 1, 'state': 'running', 'ownerSessionId': 'other-owner'}],
        }
        for label, rows in cases.items():
            ledger = []
            transport = FakeTransport(ledger, rows=rows)

            result = admit(config(), request(), transport, persist=recorder(ledger))

            self.assertEqual(result, {'status': 'refused'}, label)
            self.assertEqual([entry[0] for entry in ledger], ['persist', 'snapshot'], label)

    def test_ambiguous_transport_failure_is_not_retried(self):
        ledger = []
        transport = FakeTransport(ledger, invoke_error=TimeoutError('ambiguous'))

        result = admit(config(), request(), transport, persist=recorder(ledger))

        self.assertEqual(result, {'status': 'refused'})
        self.assertEqual([entry[0] for entry in ledger].count('invoke'), 1)

    def test_persisted_record_carries_no_token_route_or_prompt(self):
        rows = []
        transport = FakeTransport()

        admit(config(), request(), transport, persist=rows.append)

        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {'decision', 'requestId', 'parametersDigest', 'hubInstanceId', 'taskRef'})
        serialized = repr(rows[0]).lower()
        for secret in ('token', 'route', 'prompt', 'shell', 'herdr'):
            self.assertNotIn(secret, serialized)

    def test_exact_deviation_table_blocks_none_caps_and_action_escalation(self):
        transport = FakeTransport()
        self.assertTrue(allow(config(), request(basis={'deviation': 'verification_gap'} , action='request_verification'), transport))
        for deviation, action in [('blocked_waiting_human', 'request_status'), ('capacity_mismatch', 'request_status'),
                                  ('recovery_loop', 'request_status'), ('stalled_progress', 'request_verification')]:
            self.assertFalse(allow(config(), request(basis={'deviation': deviation}, action=action), transport), deviation)

    def test_digest_is_canonical_and_order_independent(self):
        forward = {'action': 'request_status', 'taskId': 'task-1', 'generation': 1}
        reversed_order = {'generation': 1, 'taskId': 'task-1', 'action': 'request_status'}

        self.assertEqual(request_digest(forward), request_digest(reversed_order))
        self.assertNotEqual(request_digest(forward), request_digest({**forward, 'generation': 2}))
        self.assertTrue(request_digest(forward).startswith('sha256:'))


if __name__ == '__main__':
    unittest.main()
