"""Pure deterministic material-event reducer; it never selects an action."""
from collections import deque
from datetime import datetime, timezone
import time

TRANSITIONS = {'task.state_changed', 'task.started', 'hub.turn_started', 'hub.turn_completed',
               'owner.lease_changed', 'action.accepted', 'action.rejected'}
# The complete plan deviation table.  These names are facts/candidates only, never actions.
DEVIATIONS = frozenset({'stalled_progress', 'silent_progress', 'blocked_waiting_human',
 'verification_gap', 'scope_drift', 'repeated_failure', 'research_gap', 'queue_starvation',
 'capacity_mismatch', 'recovery_loop', 'owner_offline', 'stale_generation',
 'route_unavailable', 'unsafe_action_request'})
CRITICAL = frozenset({'owner_offline', 'route_unavailable', 'unsafe_action_request', 'recovery_loop'})


def _state(value):
    value = dict(value)
    value.setdefault('seen_ids', deque(maxlen=4096)); value.setdefault('seen_set', set(value['seen_ids']))
    value.setdefault('latest_generation', {}); value.setdefault('last_material', {}); value.setdefault('last_output', {})
    value.setdefault('task_state', {}); value.setdefault('cooldowns', {}); value.setdefault('route_times', deque())
    value.setdefault('offline', deque()); value.setdefault('offline_bytes', 0); value.setdefault('last_monotonic', float('-inf'))
    return value


def _candidate(event, task, newest):
    kind, target = event.get('kind'), task.get('toState')
    if task.get('generation', 0) < newest or kind == 'task.generation_superseded': return 'stale_generation'
    if kind == 'task.state_changed' and target == 'blocked': return 'blocked_waiting_human'
    if kind == 'task.state_changed' and target == 'failed': return 'repeated_failure'
    if kind == 'hub.capability_changed': return 'capacity_mismatch'
    if kind == 'owner.orphaned': return 'owner_offline'
    if kind == 'owner.recovering': return 'recovery_loop'
    if kind == 'action.rejected': return 'unsafe_action_request'
    if kind == 'hub.queue_depth_changed' and event.get('queueDepth', 0) > 0: return 'queue_starvation'
    if kind == 'task.output_advanced' and event.get('completionIntent') and not event.get('assertionEvidence'): return 'verification_gap'
    if kind == 'task.output_advanced' and event.get('scopeWatchdog'): return 'scope_drift'
    if kind == 'task.output_advanced' and event.get('researchMissing'): return 'research_gap'
    if kind == 'route.unavailable': return 'route_unavailable'
    return None


def _allowed(state, record, now):
    deviation = record.get('candidateDeviation')
    if not deviation: return True
    severity = 'critical' if deviation in CRITICAL else 'info' if deviation == 'blocked_waiting_human' else 'warning'
    task = record['taskRef']; key = (task['taskId'], task['generation'], deviation)
    # per-task policy: info 60s, warning 15s, critical duplicate 5m
    floor = 300 if severity == 'critical' else 60 if severity == 'info' else 15
    if now - state['cooldowns'].get(key, float('-inf')) < floor: return False
    route = state['route_times']
    while route and now - route[0] > 3600: route.popleft()
    if len(route) >= 30 or sum(item > now - 60 for item in route) >= 6: return False
    state['cooldowns'][key] = now; route.append(now); record['severity'] = severity
    return True


def _buffer_offline(state, record):
    raw = str(record).encode('utf-8')
    if len(raw) > 262144: return
    state['offline'].append(record); state['offline_bytes'] += len(raw)
    while len(state['offline']) > 100 or state['offline_bytes'] > 262144:
        state['offline_bytes'] -= len(str(state['offline'].popleft()).encode('utf-8'))


def drain_offline(value):
    state = _state(value); records = list(state['offline'])
    state['offline'].clear(); state['offline_bytes'] = 0
    return state, records


def reduce_event(value, event, now, online=True):
    state = _state(value)
    # monotonic rollback must never reopen cooldowns/timers.
    now = max(now, state['last_monotonic']); state['last_monotonic'] = now
    sequence, event_id = event.get('eventSequence'), event.get('eventId')
    if not isinstance(sequence, int) or sequence <= state.get('sequence', 0) or not isinstance(event_id, str) or event_id in state['seen_set']:
        return state, []
    state['sequence'] = sequence
    if len(state['seen_ids']) == state['seen_ids'].maxlen: state['seen_set'].discard(state['seen_ids'][0])
    state['seen_ids'].append(event_id); state['seen_set'].add(event_id)
    task = event.get('task') or {}; task_id, generation = task.get('id'), task.get('generation')
    if not isinstance(task_id, str) or not isinstance(generation, int): return state, []
    key = (task_id, generation); newest = max(state['latest_generation'].get(task_id, 0), generation)
    state['latest_generation'][task_id] = newest
    occurred = event.get('occurredAt')
    try:
        occurred_at = datetime.fromisoformat(occurred.replace('Z', '+00:00')).astimezone(timezone.utc).timestamp()
    except (AttributeError, ValueError):
        # Missing/malformed Hub time is history only: never an actionable candidate.
        occurred_at = float('-inf')
    age = max(0, time.time() - occurred_at)
    material = event.get('kind') in TRANSITIONS or event.get('kind') in {'hub.capability_changed', 'owner.orphaned', 'owner.recovering', 'task.generation_superseded', 'route.unavailable', 'hub.queue_depth_changed'}
    if event.get('kind') == 'task.output_advanced':
        material = now - state['last_output'].get(key, float('-inf')) >= 2
        state['last_output'][key] = now
    if not material: return state, []
    target_state = task.get('toState', state['task_state'].get(key))
    state['task_state'][key] = target_state
    if event.get('kind') == 'task.state_changed' and target_state in {'completed', 'blocked', 'failed', 'cancelled', 'orphaned'}:
        # Terminal generations cannot stall; retaining them grows this state forever.
        state['last_material'].pop(key, None)
        state['last_output'].pop(key, None)
    else:
        state['last_material'][key] = now
    candidate = _candidate(event, task, newest)
    stale = age > 120 or generation < newest
    if stale: candidate = None
    record = {'eventId': event_id, 'taskRef': {'taskId': task_id, 'generation': generation}, 'candidateDeviation': candidate, 'stale': stale}
    if not _allowed(state, record, now): return state, []
    if not online: _buffer_offline(state, record); return state, []
    return state, [record]


def due_deviations(value, now, stall_seconds=600, online=True):
    state = _state(value); now = max(now, state['last_monotonic']); state['last_monotonic'] = now; output = []
    for key, last in state['last_material'].items():
        candidate = 'silent_progress' if key in state['last_output'] and now - state['last_output'][key] >= 300 and state['last_output'][key] >= last else 'stalled_progress'
        if now - last >= stall_seconds:
            record = {'taskRef': {'taskId': key[0], 'generation': key[1]}, 'candidateDeviation': candidate}
            if _allowed(state, record, now):
                if online: output.append(record)
                else: _buffer_offline(state, record)
    return output


def bulgarian_summary(record):
    ref = record.get('taskRef', {})
    return f"ℹ️ задача `{ref.get('taskId', '?')}`, поколение {ref.get('generation', '?')}: {record.get('candidateDeviation') or 'съществена промяна'}."
