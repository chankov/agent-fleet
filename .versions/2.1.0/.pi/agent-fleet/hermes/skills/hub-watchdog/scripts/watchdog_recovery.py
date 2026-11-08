"""Exact-generation surgical transaction. No retargeting, retries, or shell execution."""
import time

from watchdog_actions import transport_identity

TERMINAL = {'completed', 'failed', 'cancelled', 'orphaned'}
IDENTITY_KEYS = ('profileKey', 'hubInstanceId', 'ownerSessionId')
CANCEL_TIMEOUT_SECONDS = 15


def _identity_bound(tx, api):
    """Exact identity is mandatory; a missing field is a refusal, not a wildcard."""
    identity = transport_identity(api)
    for key in IDENTITY_KEYS:
        value = tx.get(key)
        if not isinstance(value, str) or not value:
            return False
        if identity.get(key) != value:
            return False
    return True


def _compare_and_swap(tx, api):
    """
    Fresh snapshot read before every step. Returns ('ok', exact_row),
    ('superseded', None) when an N+1 generation exists, or ('refused', None).
    """
    rows = api.snapshot(tx['taskId'])
    if not isinstance(rows, list):
        return 'refused', None
    if any(isinstance(row, dict) and row.get('generation', 0) > tx['generation'] for row in rows):
        return 'superseded', None
    exact = next((row for row in rows if isinstance(row, dict) and row.get('generation') == tx['generation']), None)
    if not isinstance(exact, dict):
        return 'refused', None
    if exact.get('ownerSessionId') != tx['ownerSessionId']:
        return 'refused', None
    return 'ok', exact


def _start_cancel(tx, api, now, persist):
    """Persist the proposal, re-check the generation, then cancel exactly N."""
    if persist is None:
        return {**tx, 'state': 'refused'}
    try:
        persist({'decision': 'recovery_proposed', 'hubInstanceId': tx['hubInstanceId'],
                 'taskRef': {'taskId': tx['taskId'], 'generation': tx['generation']}})
    except Exception:
        return {**tx, 'state': 'refused'}
    verdict, _ = _compare_and_swap(tx, api)
    if verdict != 'ok':
        return {**tx, 'state': verdict}
    result = api.cancel(tx['taskId'], tx['generation'])
    if not isinstance(result, dict) or not result.get('cancelled'):
        return {**tx, 'state': 'refused'}
    return {**tx, 'state': 'cancelling', 'cancelStartedAt': now}


def _observe_cancel(tx, api, now):
    """Wait for the exact generation to reach a terminal state, bounded by a timeout."""
    verdict, exact = _compare_and_swap(tx, api)
    if verdict != 'ok':
        return {**tx, 'state': verdict}
    if exact.get('state') in TERMINAL:
        return {**tx, 'state': 'cancel_observed'}
    if now - tx.get('cancelStartedAt', now) >= CANCEL_TIMEOUT_SECONDS:
        return {**tx, 'state': 'timed_out'}
    return tx


def _enqueue_recovery(tx, api):
    """One recovery enqueue, gated on a fresh no-N+1 terminal observation."""
    verdict, exact = _compare_and_swap(tx, api)
    if verdict != 'ok':
        return {**tx, 'state': verdict}
    if exact.get('state') not in TERMINAL:
        return {**tx, 'state': 'refused'}
    outcome = api.invoke_recovery(tx['taskId'], tx['generation'])
    if isinstance(outcome, dict) and outcome.get('status') in ('accepted', 'duplicate'):
        return {**tx, 'state': 'recovery_queued'}
    return {**tx, 'state': 'refused'}


def recover(tx, api, allowlist, gate_o, now=None, persist=None):
    """
    Advance the local recovery state machine by exactly one step. Terminal
    states are absorbing, so a restart can never repeat a completed step.
    """
    now = time.monotonic() if now is None else now
    if not gate_o or tx.get('taskId') not in allowlist or tx.get('kind') != 'native':
        return {**tx, 'state': 'refused'}
    if not isinstance(tx.get('generation'), int) or tx['generation'] <= 0:
        return {**tx, 'state': 'refused'}
    if not _identity_bound(tx, api):
        return {**tx, 'state': 'refused'}
    state = tx.get('state', 'proposed')
    if state == 'proposed':
        return _start_cancel(tx, api, now, persist)
    if state == 'cancelling':
        return _observe_cancel(tx, api, now)
    if state == 'cancel_observed':
        return _enqueue_recovery(tx, api)
    return tx
