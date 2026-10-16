"""Closed typed invoke admission; watcher never calls tools or shell."""
import hashlib
import json

from watchdog_contract import gate_o_valid

# Exact plan table: a deviation can only request its declared maximum action.
MAXIMUM_ACTION = {
    'stalled_progress': 'request_status', 'silent_progress': 'request_status',
    'blocked_waiting_human': 'none', 'verification_gap': 'request_verification',
    'scope_drift': 'narrow_scope', 'repeated_failure': 'request_specialist',
    'research_gap': 'request_research', 'queue_starvation': 'request_status',
    'capacity_mismatch': 'none', 'recovery_loop': 'none', 'owner_offline': 'none',
    'stale_generation': 'none', 'route_unavailable': 'none', 'unsafe_action_request': 'none',
}
ACTIONS = set(MAXIMUM_ACTION.values()) - {'none'}
IDENTITY_KEYS = ('profileKey', 'ownerSessionId', 'hubInstanceId')
TERMINAL_STATES = {'completed', 'failed', 'cancelled', 'orphaned'}
# Authority a typed request must never carry, whatever the caller supplies.
FORBIDDEN_REQUEST_KEYS = ('token', 'origin', 'route', 'routeId', 'prompt', 'command', 'shell', 'herdr', 'tool')


def request_digest(request):
    """Canonical digest over the exact request that will be transported."""
    canonical = json.dumps(request, sort_keys=True, separators=(',', ':')).encode()
    return 'sha256:' + hashlib.sha256(canonical).hexdigest()


def transport_identity(transport):
    """Identity as the live discovery/transport reports it, not as a caller claims."""
    return {
        'profileKey': getattr(transport, 'profile_key', None),
        'ownerSessionId': getattr(transport, 'owner', None),
        'hubInstanceId': getattr(transport, 'hub_instance_id', None),
    }


def _identity_matches(config, request, identity):
    """Config, request, and the live transport must agree on every identity key."""
    for key in IDENTITY_KEYS:
        expected = config.get(key)
        if not isinstance(expected, str) or not expected:
            return False
        if request.get(key) != expected:
            return False
        if identity.get(key) != expected:
            return False
    return True


def allow(config, request, transport, online=True):
    """Pure admission check. Makes no transport call, so observe/shadow stay silent."""
    if not online or not gate_o_valid(config.get('gateO')):
        return False
    autonomy = config.get('autonomy', 'observe')
    maximum = config.get('maximumAutonomy', 'observe')
    if autonomy not in ('steer', 'surgical') or maximum not in ('steer', 'surgical'):
        return False
    if request.get('action') not in ACTIONS or request.get('cancel'):
        return False
    basis = request.get('basis')
    if not isinstance(basis, dict) or basis.get('deviation') not in MAXIMUM_ACTION:
        return False
    if request['action'] != MAXIMUM_ACTION[basis['deviation']]:
        return False
    if not isinstance(request.get('taskId'), str) or not request['taskId']:
        return False
    if not isinstance(request.get('generation'), int) or request['generation'] <= 0:
        return False
    parameters = request.get('parameters')
    if not isinstance(parameters, dict) or set(parameters) - {'assertionIds', 'evidenceEventIds', 'instruction'}:
        return False
    for key, maximum in (('assertionIds', 20), ('evidenceEventIds', 20)):
        values = parameters.get(key)
        if not isinstance(values, list) or len(values) > maximum or not all(isinstance(value, str) and 0 < len(value) <= 128 for value in values):
            return False
    if not isinstance(parameters.get('instruction'), str) or not parameters['instruction'] or len(parameters['instruction']) > 1024:
        return False
    if any(key in request for key in FORBIDDEN_REQUEST_KEYS):
        return False
    return _identity_matches(config, request, transport_identity(transport))


def _target_current(transport, request):
    """Fresh read: the exact generation must still exist, be owned, and not be terminal."""
    try:
        rows = transport.snapshot(request['taskId'])
    except Exception:
        return False
    if not isinstance(rows, list):
        return False
    if any(isinstance(row, dict) and row.get('generation', 0) > request['generation'] for row in rows):
        return False
    exact = next((row for row in rows if isinstance(row, dict) and row.get('generation') == request['generation']), None)
    if not isinstance(exact, dict) or exact.get('state') in TERMINAL_STATES:
        return False
    # Snapshot rows name the Hub-authoritative owner session explicitly. Never
    # accept a similarly named caller-provided `ownerId`.
    return exact.get('ownerSessionId') == request['ownerSessionId']


def admit(config, request, transport, online=True, persist=None):
    """
    Durability precedes transport: the canonical digest and the proposed decision
    are persisted before the first transport call. Ambiguous failure is refusal,
    never a retry.
    """
    if not allow(config, request, transport, online):
        return {'status': 'refused'}
    if persist is None:
        return {'status': 'refused'}
    try:
        persist({'decision': 'invoke_proposed', 'requestId': request.get('requestId'),
                 'parametersDigest': request_digest(request), 'hubInstanceId': request['hubInstanceId'],
                 'taskRef': {'taskId': request['taskId'], 'generation': request['generation']}})
    except Exception:
        return {'status': 'refused'}
    if not _target_current(transport, request):
        return {'status': 'refused'}
    try:
        result = transport.invoke(request)
    except Exception:
        return {'status': 'refused'}
    return result if isinstance(result, dict) else {'status': 'refused'}
