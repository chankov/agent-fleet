"""Bounded semantic classification contract; invalid answers are no-ops."""
import json

from watchdog_actions import MAXIMUM_ACTION
ACTIONS = {'none', 'request_status', 'request_verification', 'narrow_scope', 'request_research', 'request_specialist'}
FORBIDDEN = ('token', 'route', 'prompt', 'transcript', 'toolarg', 'chatid', 'sessionid')


def request(candidate, events, output='', task_ref=None):
    if not isinstance(candidate, str) or not isinstance(events, list) or len(events) > 20:
        raise ValueError('evidence_bounds')
    if not isinstance(output, str) or len(output.encode()) > 4096:
        raise ValueError('evidence_bounds')
    if not isinstance(task_ref or {}, dict) or not isinstance((task_ref or {}).get('generation'), (int, type(None))):
        raise ValueError('evidence_bounds')
    if any(not isinstance(item, str) or any(word in item.lower() for word in FORBIDDEN) for item in events):
        raise ValueError('unsafe_evidence')
    evidence = json.dumps(events, separators=(',', ':')).encode()
    if len(evidence) > 8192 or any(word in output.lower() for word in FORBIDDEN):
        raise ValueError('evidence_bounds')
    return {'schema': 'agent-fleet.watchdog-judgment-request', 'schemaVersion': 1,
            'candidateDeviation': candidate, 'taskRef': task_ref or {},
            'evidence': {'events': events, 'publicOutputSuffix': output, 'truncated': False},
            'allowedRecommendations': sorted({'none', MAXIMUM_ACTION.get(candidate, 'none')})}


def response(value, deviation, event_ids):
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        confidence = parsed.get('confidence') if isinstance(parsed, dict) else None
        supplied = parsed.get('evidenceEventIds') if isinstance(parsed, dict) else None
        if (not isinstance(parsed, dict) or parsed.get('deviation') != deviation or
                parsed.get('verdict') != 'confirmed' or parsed.get('recommendedAction') not in ACTIONS or
                parsed.get('recommendedAction') not in {'none', MAXIMUM_ACTION.get(deviation, 'none')} or
                isinstance(confidence, bool) or not isinstance(confidence, (float, int)) or confidence < .8 or
                not isinstance(supplied, list) or not supplied or not all(isinstance(item, str) for item in supplied) or
                not set(supplied).issubset(set(event_ids))):
            raise ValueError('invalid_judgment')
        return parsed
    except Exception:
        return {'verdict': 'none', 'recommendedAction': 'none'}
