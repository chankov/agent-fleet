"""Surgical recovery: exact identity, compare-and-swap, and at-most-one enqueue."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/hub-watchdog/scripts'))

from watchdog_recovery import CANCEL_TIMEOUT_SECONDS, recover  # noqa: E402

PROFILE_KEY = 'p' * 64
HUB_ID = 'hub-instance-1'
OWNER = 'owner-1'
TASK = 'task-1'


class FakeApi:
    """Monitor adapter with a call ledger; rows can change between steps."""

    def __init__(self, rows=None, cancelled=True, recovery_status='accepted'):
        self.rows = rows if rows is not None else [{'generation': 1, 'state': 'cancelled', 'ownerSessionId': OWNER}]
        self.cancelled = cancelled
        self.recovery_status = recovery_status
        self.calls = []
        self.profile_key = PROFILE_KEY
        self.owner = OWNER
        self.hub_instance_id = HUB_ID

    def cancel(self, task_id, generation):
        self.calls.append(('cancel', task_id, generation))
        return {'cancelled': self.cancelled}

    def snapshot(self, task_id=None):
        self.calls.append(('snapshot', task_id))
        return self.rows

    def invoke_recovery(self, task_id, generation):
        self.calls.append(('invoke_recovery', task_id, generation))
        return {'status': self.recovery_status}

    @property
    def kinds(self):
        return [call[0] for call in self.calls]


def transaction(**overrides):
    base = {'taskId': TASK, 'generation': 1, 'kind': 'native',
            'profileKey': PROFILE_KEY, 'ownerSessionId': OWNER, 'hubInstanceId': HUB_ID}
    base.update(overrides)
    return base


def running(generation=1, owner=OWNER):
    return {'generation': generation, 'state': 'running', 'ownerSessionId': owner}


def cancelled(generation=1, owner=OWNER):
    return {'generation': generation, 'state': 'cancelled', 'ownerSessionId': owner}


def drive(tx, api, persist=None, allowlist=(TASK,), now=None):
    return recover(tx, api, list(allowlist), True, now=now, persist=persist or (lambda _row: None))


class SurgicalRecovery(unittest.TestCase):
    def test_closed_gate_non_native_or_unlisted_task_never_cancels(self):
        for label, tx, allowlist, gate in (
            ('gate closed', transaction(), [TASK], False),
            ('coms task', transaction(kind='coms'), [TASK], True),
            ('unlisted task', transaction(), [], True),
            ('bad generation', transaction(generation=0), [TASK], True),
        ):
            api = FakeApi()

            result = recover(tx, api, allowlist, gate, persist=lambda _row: None)

            self.assertEqual(result['state'], 'refused', label)
            self.assertEqual(api.calls, [], label)

    def test_missing_identity_is_refused_rather_than_treated_as_a_wildcard(self):
        for key in ('profileKey', 'ownerSessionId', 'hubInstanceId'):
            api = FakeApi()

            missing = drive(transaction(**{key: None}), api)
            mismatched = drive(transaction(**{key: 'forged'}), api)

            self.assertEqual(missing['state'], 'refused', f'missing {key}')
            self.assertEqual(mismatched['state'], 'refused', f'mismatched {key}')
            self.assertEqual(api.calls, [], key)

    def test_a_row_without_an_owner_never_satisfies_the_owner_binding(self):
        api = FakeApi(rows=[{'generation': 1, 'state': 'running'}])

        result = drive(transaction(), api)

        self.assertEqual(result['state'], 'refused')
        self.assertNotIn('cancel', api.kinds)

    def test_proposal_persists_before_the_cancel_transport_call(self):
        ledger = []
        api = FakeApi(rows=[running()])

        def persist(row):
            ledger.append(('persist', row['decision']))
            api.calls.append(('persist', row['decision']))

        result = drive(transaction(), api, persist=persist, now=0)

        self.assertEqual(result['state'], 'cancelling')
        self.assertEqual(api.kinds, ['persist', 'snapshot', 'cancel'])
        self.assertEqual(ledger, [('persist', 'recovery_proposed')])

    def test_persistence_failure_refuses_before_any_cancel(self):
        api = FakeApi(rows=[running()])

        def failing_persist(_row):
            raise OSError('disk full')

        result = drive(transaction(), api, persist=failing_persist)

        self.assertEqual(result['state'], 'refused')
        self.assertEqual(api.calls, [])

    def test_absent_persistence_hook_refuses_before_any_cancel(self):
        api = FakeApi(rows=[running()])

        result = recover(transaction(), api, [TASK], True)

        self.assertEqual(result['state'], 'refused')
        self.assertEqual(api.calls, [])

    def test_full_native_sequence_queues_exactly_one_recovery(self):
        api = FakeApi(rows=[running()])
        tx = drive(transaction(), api, now=0)
        self.assertEqual(tx['state'], 'cancelling')

        api.rows = [cancelled()]
        tx = drive(tx, api, now=1)
        self.assertEqual(tx['state'], 'cancel_observed')

        tx = drive(tx, api, now=2)
        self.assertEqual(tx['state'], 'recovery_queued')

        self.assertEqual(api.kinds, ['snapshot', 'cancel', 'snapshot', 'snapshot', 'invoke_recovery'])
        self.assertEqual(api.calls.count(('invoke_recovery', TASK, 1)), 1)
        self.assertEqual(api.calls[1], ('cancel', TASK, 1), 'cancel names the exact generation')

    def test_a_completed_transaction_is_absorbing_across_restart(self):
        api = FakeApi(rows=[cancelled()])
        tx = drive(transaction(state='recovery_queued'), api)

        self.assertEqual(tx['state'], 'recovery_queued')
        self.assertEqual(api.calls, [], 'a completed step is never repeated')

    def test_a_newer_generation_before_cancel_supersedes_without_cancelling(self):
        api = FakeApi(rows=[running(), running(generation=2)])

        result = drive(transaction(), api)

        self.assertEqual(result['state'], 'superseded')
        self.assertNotIn('cancel', api.kinds)
        self.assertNotIn('invoke_recovery', api.kinds)

    def test_a_newer_generation_during_cancel_supersedes_without_recovery(self):
        api = FakeApi(rows=[running()])
        tx = drive(transaction(), api, now=0)

        api.rows = [cancelled(), running(generation=2)]
        result = drive(tx, api, now=1)

        self.assertEqual(result['state'], 'superseded')
        self.assertNotIn('invoke_recovery', api.kinds)

    def test_a_newer_generation_after_terminal_observation_blocks_the_enqueue(self):
        api = FakeApi(rows=[running()])
        tx = drive(transaction(), api, now=0)
        api.rows = [cancelled()]
        tx = drive(tx, api, now=1)
        self.assertEqual(tx['state'], 'cancel_observed')

        api.rows = [cancelled(), running(generation=2)]
        result = drive(tx, api, now=2)

        self.assertEqual(result['state'], 'superseded')
        self.assertNotIn('invoke_recovery', api.kinds)

    def test_owner_rollover_between_steps_refuses_instead_of_retargeting(self):
        api = FakeApi(rows=[running()])
        tx = drive(transaction(), api, now=0)

        api.rows = [cancelled(owner='owner-2')]
        result = drive(tx, api, now=1)

        self.assertEqual(result['state'], 'refused')
        self.assertNotIn('invoke_recovery', api.kinds)

    def test_a_refused_cancel_never_advances_the_transaction(self):
        api = FakeApi(rows=[running()], cancelled=False)

        result = drive(transaction(), api)

        self.assertEqual(result['state'], 'refused')
        self.assertNotIn('invoke_recovery', api.kinds)

    def test_exit_not_observed_times_out_without_recovery(self):
        api = FakeApi(rows=[running()])
        tx = drive(transaction(), api, now=0)

        self.assertEqual(drive(tx, api, now=CANCEL_TIMEOUT_SECONDS - 1)['state'], 'cancelling')
        timed_out = drive(tx, api, now=CANCEL_TIMEOUT_SECONDS)

        self.assertEqual(timed_out['state'], 'timed_out')
        self.assertNotIn('invoke_recovery', api.kinds)
        self.assertEqual(drive(timed_out, api, now=CANCEL_TIMEOUT_SECONDS + 1), timed_out)

    def test_a_rejected_recovery_enqueue_is_refused_and_not_retried(self):
        api = FakeApi(rows=[cancelled()], recovery_status='queue_full')

        result = drive(transaction(state='cancel_observed'), api)

        self.assertEqual(result['state'], 'refused')
        self.assertEqual(api.calls.count(('invoke_recovery', TASK, 1)), 1)

    def test_a_duplicate_recovery_response_still_counts_as_queued_once(self):
        api = FakeApi(rows=[cancelled()], recovery_status='duplicate')

        result = drive(transaction(state='cancel_observed'), api)

        self.assertEqual(result['state'], 'recovery_queued')
        self.assertEqual(api.calls.count(('invoke_recovery', TASK, 1)), 1)

    def test_a_non_terminal_target_at_enqueue_time_is_refused(self):
        api = FakeApi(rows=[running()])

        result = drive(transaction(state='cancel_observed'), api)

        self.assertEqual(result['state'], 'refused')
        self.assertNotIn('invoke_recovery', api.kinds)


if __name__ == '__main__':
    unittest.main()
