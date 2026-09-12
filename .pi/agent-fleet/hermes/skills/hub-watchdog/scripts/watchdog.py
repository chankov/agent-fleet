#!/usr/bin/env python3
"""Foreground fail-closed watchdog entrypoint; no daemon/service lifecycle."""
import argparse
import hashlib
import json
import os
import selectors
import signal
import sys
import time
from pathlib import Path

from watchdog_actions import MAXIMUM_ACTION, admit
from watchdog_contract import gate_o_valid
from watchdog_delivery import deliver, delivery_state
from watchdog_engine import bulgarian_summary, due_deviations, reduce_event
from watchdog_judgment import request as judgment_request, response as judgment_response
from watchdog_recovery import recover
from watchdog_state import atomic_json, audit, load_json, profile_root
from watchdog_transport import MonitorTransport, TransportError, discover, reconcile

LEVELS = ('observe', 'shadow', 'steer', 'surgical')


def request_id(record, profile_key, owner_session_id, hub_instance_id):
    """Canonical owner/profile/generation identity for a single Hub invoke."""
    ref = record['taskRef']
    payload = json.dumps({'deviation': record.get('candidateDeviation'), 'taskId': ref['taskId'],
                          'generation': ref['generation'], 'profileKey': profile_key,
                          'ownerSessionId': owner_session_id, 'hubInstanceId': hub_instance_id},
                         sort_keys=True, separators=(',', ':')).encode()
    return 'watchdog:' + hashlib.sha256(payload).hexdigest()


def safe_invocation(raw):
    try:
        value = json.loads(raw or '{}')
    except json.JSONDecodeError as error:
        raise ValueError('invalid_invocation') from error
    if not isinstance(value, dict):
        raise ValueError('invalid_invocation')
    requested = value.get('autonomy', 'observe')
    maximum = value.get('maximumAutonomy', 'observe')
    if requested not in LEVELS or maximum not in LEVELS:
        raise ValueError('invalid_autonomy')
    level = LEVELS[min(LEVELS.index(requested), LEVELS.index(maximum))]
    if not delivery_state(value.get('gateO'))['originDelivery'] and level in ('steer', 'surgical'):
        level = 'observe'
    return value, level


def _lock(invocation):
    root = Path(invocation.get('lockDir') or os.environ.get('XDG_RUNTIME_DIR', '/tmp'))
    # is_symlink() uses lstat: reject even a dangling link before any operation
    # that could follow it (exists, mkdir, chmod, or stat).
    if root.is_symlink():
        raise ValueError('unsafe_lock')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir() or root.stat().st_mode & 0o077:
        raise ValueError('unsafe_lock')
    root = root.resolve(strict=True)
    path = root / 'agent-fleet-hermes-watchdog' / profile_root('', invocation.get('profileId', 'default')).name / 'watch.lock'
    # Refuse a pre-existing symlink before mkdir/chmod can follow it.
    for parent in (path.parent.parent, path.parent):
        if parent.is_symlink() or (parent.exists() and (not parent.is_dir() or root not in (parent.resolve(), *parent.resolve().parents))):
            raise ValueError('unsafe_lock')
        parent.mkdir(mode=0o700, exist_ok=True)
        if parent.is_symlink() or not parent.is_dir() or root not in (parent.resolve(), *parent.resolve().parents):
            raise ValueError('unsafe_lock')
        os.chmod(parent, 0o700)
        if parent.stat().st_mode & 0o077:
            raise ValueError('unsafe_lock')
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        try:
            contents = path.read_text(encoding='ascii').strip()
            if path.is_symlink() or not contents.isdecimal() or int(contents) <= 0:
                raise ValueError('unsafe_lock')
            os.kill(int(contents), 0)
        except ProcessLookupError:
            path.unlink()
            return _lock(invocation)
        except (OSError, UnicodeError, ValueError) as error:
            raise ValueError('watcher_locked') from error
        raise ValueError('watcher_locked')
    os.write(descriptor, str(os.getpid()).encode())
    return path, descriptor


def _audit_path(invocation):
    base = invocation.get('stateDir') or os.environ.get('XDG_STATE_HOME') or str(Path.home() / '.local/state')
    return profile_root(Path(base) / 'agent-fleet/hermes-watchdog', invocation.get('profileId', 'default')) / 'audit.ndjson'


def _recovery_path(invocation):
    return _audit_path(invocation).with_name('recovery.json')


def _recovery_key(task_ref):
    return json.dumps([task_ref['taskId'], task_ref['generation']], separators=(',', ':'))


def _load_recovery(invocation):
    path = _recovery_path(invocation)
    try:
        value = load_json(path) if path.exists() else {}
        return value if isinstance(value, dict) and all(isinstance(tx, dict) for tx in value.values()) else {}
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def _save_recovery(invocation, transaction):
    try:
        atomic_json(_recovery_path(invocation), transaction)
        return True
    except (OSError, ValueError):
        return False


def _safe_audit(path, record):
    """Offline/corrupt local audit is fail-closed but must not crash the watcher."""
    try:
        audit(path, record)
        return True
    except (OSError, ValueError):
        return False


def _action_for(record, invocation):
    """Only a validated judgment may confirm an invoke; it can never escalate the table action."""
    deviation = record.get('candidateDeviation')
    maximum = MAXIMUM_ACTION.get(deviation, 'none')
    adapter = invocation.get('judgmentAdapter')
    if maximum == 'none' or not adapter:
        return 'none', None
    try:
        verdict = judgment_response(adapter(judgment_request(
            deviation, [record['eventId']], task_ref=record['taskRef'])), deviation, [record['eventId']])
        recommended = verdict['recommendedAction']
        return (recommended, verdict['verdict']) if recommended == maximum and verdict['verdict'] == 'confirmed' else ('none', None)
    except (ValueError, TypeError, KeyError):
        return 'none', None


def run_watch(invocation, level, *, once=False, transport_factory=None):
    """Run the foreground polling/event loop. Dependencies are injectable only for tests."""
    lock_path, lock_fd = _lock(invocation)
    state, cursor, stopped = {}, 0, False
    recovery_transactions = _load_recovery(invocation)
    selector = selectors.DefaultSelector()
    read_fd, write_fd = os.pipe()
    os.set_blocking(read_fd, False)
    selector.register(read_fd, selectors.EVENT_READ)
    old_handler = signal.getsignal(signal.SIGINT)

    def stop(*_):
        nonlocal stopped
        stopped = True
        try: os.write(write_fd, b'x')
        except OSError: pass

    audit_path = _audit_path(invocation)
    try:
        signal.signal(signal.SIGINT, stop)
        while not stopped:
            try:
                factory = transport_factory or (lambda: MonitorTransport(discover(
                    invocation['runtimeDir'], invocation['profileKey'], invocation['hubKey'],
                    invocation.get('now') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))))
                transport = factory()
                batch = reconcile(transport, cursor)
                if batch.get('snapshot'):
                    cursor = 0
                    _safe_audit(audit_path, {'decision': 'snapshot_reconciled', 'hubInstanceId': invocation.get('hubInstanceId')})
                events = batch.get('items', batch.get('events', []))
                for event in events:
                    state, records = reduce_event(state, event, time.monotonic(), online=True)
                    cursor = max(cursor, event.get('eventSequence', cursor))
                    for record in records:
                        _safe_audit(audit_path, {'decision': 'material_event', 'hubInstanceId': invocation.get('hubInstanceId'),
                                           'taskRef': record['taskRef'], 'eventIds': [record['eventId']],
                                           'deviation': record.get('candidateDeviation'), 'tier': level})
                        action, judgment = _action_for(record, invocation)
                        # Gate O is the hard boundary: otherwise journal-only and no invoke/cancel.
                        if level in ('steer', 'surgical') and action != 'none' and judgment == 'confirmed':
                            request = {'requestId': request_id(record, invocation.get('profileKey'), transport.owner, invocation.get('hubInstanceId')), 'action': action,
                                       'taskId': record['taskRef']['taskId'], 'generation': record['taskRef']['generation'],
                                       'profileKey': invocation.get('profileKey'), 'ownerSessionId': transport.owner,
                                       'hubInstanceId': invocation.get('hubInstanceId'),
                                       'parameters': {'assertionIds': [], 'evidenceEventIds': [record['eventId']],
                                                      'instruction': 'Изпълни ограничената проверка и докладвай доказателства.'},
                                       'basis': {'deviation': record['candidateDeviation'], 'judgment': judgment}}
                            admit({**invocation, 'autonomy': level, 'ownerSessionId': transport.owner}, request, transport,
                                  persist=lambda row: _safe_audit(audit_path, row))
                        if delivery_state(invocation.get('gateO'))['originDelivery'] and invocation.get('origin'):
                            try:
                                deliver(invocation['gateO'], invocation['origin'], bulgarian_summary(record), invocation.get('deliveryAdapter'))
                            except RuntimeError:
                                _safe_audit(audit_path, {'decision': 'delivery_refused', 'hubInstanceId': invocation.get('hubInstanceId'),
                                                         'taskRef': record['taskRef'], 'tier': level})
                for record in due_deviations(state, time.monotonic()):
                    _safe_audit(audit_path, {'decision': 'due_deviation', 'hubInstanceId': invocation.get('hubInstanceId'),
                                       'taskRef': record['taskRef'], 'deviation': record['candidateDeviation'], 'tier': level})
                    # Due deviations use the same exact table and recovery gate as event candidates.
                    if level == 'surgical' and gate_o_valid(invocation.get('gateO')) and record['candidateDeviation'] == 'stalled_progress':
                        key = _recovery_key(record['taskRef'])
                        transaction = recovery_transactions.get(key, {'taskId': record['taskRef']['taskId'], 'generation': record['taskRef']['generation'],
                                       'kind': 'native', 'ownerSessionId': transport.owner, 'profileKey': invocation.get('profileKey'),
                                       'hubInstanceId': invocation.get('hubInstanceId'), 'state': 'proposed'})
                        recovery = recover(transaction, transport, invocation.get('surgicalAllowlist', []), True,
                                           persist=lambda row: _safe_audit(audit_path, row))
                        recovery_transactions[key] = recovery
                        _save_recovery(invocation, recovery_transactions)
                        _safe_audit(audit_path, {'decision': 'recovery_checked', 'hubInstanceId': invocation.get('hubInstanceId'),
                                                  'taskRef': {'taskId': recovery['taskId'], 'generation': recovery['generation']}, 'recoveryState': recovery['state'], 'tier': level})
            except (KeyError, TransportError, ValueError, OSError) as error:
                _safe_audit(audit_path, {'decision': 'offline', 'hubInstanceId': invocation.get('hubInstanceId'),
                                   'deviation': 'route_unavailable'})
                if once:
                    return {'foreground': True, 'offline': True, 'autonomy': level}
                selector.select(timeout=.25)
            if once:
                return {'foreground': True, 'offline': False, 'autonomy': level, 'cursor': cursor}
        return {'foreground': True, 'stopped': True, 'autonomy': level}
    finally:
        signal.signal(signal.SIGINT, old_handler)
        selector.close(); os.close(read_fd); os.close(write_fd); os.close(lock_fd)
        try: lock_path.unlink()
        except FileNotFoundError: pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['status', 'validate-config', 'watch'])
    parser.add_argument('--invocation-json')
    parser.add_argument('--once', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        invocation, level = safe_invocation(args.invocation_json)
        result = {'ok': True, 'autonomy': level, **delivery_state(invocation.get('gateO'))}
        if args.command == 'watch':
            result.update(run_watch(invocation, level, once=args.once))
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, sort_keys=True)); return 2
    print(json.dumps(result, sort_keys=True)); return 0

if __name__ == '__main__':
    raise SystemExit(main())
