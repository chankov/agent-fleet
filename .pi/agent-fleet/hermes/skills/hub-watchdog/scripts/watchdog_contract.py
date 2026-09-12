"""Closed, stdlib-only contracts for the fail-closed watchdog."""
import hashlib
import json
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

MAX_FRAME = 65536
SECRET_MARKER = re.compile(r'(?:token|bearer|secret|password|authorization|api[_-]?key)\s*[=:]', re.I)

REQUIRED_GATE_O_OBSERVATIONS = frozenset({
    'opaqueOrigin', 'threeIncrementalUpdates', 'wakeReconnect',
    'profileIsolation', 'twoChatIsolation', 'structuredInvocation',
})

def safe_file(path: Path, root: Path):
    root = root.resolve(strict=True)
    if path.is_symlink():
        raise ValueError('unsafe_file')
    path = path.resolve(strict=True)
    if root not in (path, *path.parents):
        raise ValueError('path_escape')
    value = path.stat()
    if not stat.S_ISREG(value.st_mode) or value.st_mode & 0o077:
        raise ValueError('unsafe_file')
    return path

def _parse_time(value):
    if not isinstance(value, str):
        raise ValueError('expired')
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError as error:
        raise ValueError('expired') from error

def validate_discovery(root, value, now):
    if not isinstance(value, dict) or set(value) != {'owner', 'socket', 'token', 'lease'}:
        raise ValueError('discovery')
    if not isinstance(value['owner'], str) or not value['owner']:
        raise ValueError('discovery')
    if not isinstance(value['socket'], str) or not value['socket'].startswith('@runtime/s/') or not value['socket'].endswith('/s'):
        raise ValueError('discovery')
    if not isinstance(value['token'], str) or not value['token'].startswith('token-'):
        raise ValueError('discovery')
    lease = value['lease']
    if not isinstance(lease, dict) or not isinstance(lease.get('hub'), str):
        raise ValueError('discovery')
    current = _parse_time(now) if isinstance(now, str) else now.astimezone(timezone.utc)
    if _parse_time(lease.get('expiresAt')) <= current:
        raise ValueError('expired')
    return value

def route_hash(profile, origin):
    if not isinstance(origin, dict) or not {'channel', 'chatId', 'sessionId'} <= set(origin):
        raise ValueError('origin')
    return 'sha256:' + hashlib.sha256((profile + '\0' + json.dumps(origin, sort_keys=True, separators=(',', ':'))).encode()).hexdigest()

def gate_o_valid(artifact):
    """Match the TypeScript Gate O validator; self-declared validity is not trust."""
    if not isinstance(artifact, dict) or artifact.get('unsupported') is True or artifact.get('synthetic') is True:
        return False
    api = artifact.get('api')
    observations = artifact.get('observations')
    evidence_ids = artifact.get('evidenceIds')
    def safe(value, maximum):
        return (isinstance(value, str) and value == value.strip() and 0 < len(value) <= maximum
                and SECRET_MARKER.search(value) is None)
    api_safe = (isinstance(api, dict) and safe(api.get('kind'), 64) and safe(api.get('name'), 128)
                and safe(api.get('argumentShape'), 256) and not re.search(r'\bsend\s+--to\b', api['name'], re.I))
    evidence_safe = (isinstance(evidence_ids, list) and len(evidence_ids) >= 2
                     and all(safe(item, 256) for item in evidence_ids))
    return bool(api_safe and isinstance(observations, dict)
                and all(observations.get(key) is True for key in REQUIRED_GATE_O_OBSERVATIONS)
                and evidence_safe and artifact.get('originDelivery') is True
                and safe(artifact.get('liveRunId'), 256))
