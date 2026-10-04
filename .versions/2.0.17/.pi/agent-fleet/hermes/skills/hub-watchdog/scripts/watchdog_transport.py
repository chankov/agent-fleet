"""Owner-safe, stdlib-only monitor discovery and newline JSON UDS transport."""
import json
import socket
from pathlib import Path

from watchdog_contract import MAX_FRAME, safe_file, validate_discovery

MAX_RESPONSE = 2 * 1024 * 1024

class TransportError(RuntimeError):
    pass

def discover(runtime_dir, profile_key, hub_key, now):
    """Read exactly one registry discovery entry; never scan arbitrary runtime roots."""
    root = Path(runtime_dir)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir() or root.stat().st_mode & 0o077:
        raise TransportError('unsafe_runtime')
    if not all(isinstance(key, str) and len(key) == 64 and all(char in '0123456789abcdef' for char in key) for key in (profile_key, hub_key)):
        raise TransportError('discovery')
    namespace = root / profile_key / hub_key
    try:
        if namespace.is_symlink() or not namespace.is_dir() or namespace.stat().st_mode & 0o077:
            raise ValueError('discovery')
        entries = sorted(namespace.glob('discovery-*.json'))
        if len(entries) != 1:
            raise ValueError('discovery')
        metadata = safe_file(entries[0], root)
        value = validate_discovery(root, json.loads(metadata.read_text()), now)
        token_path = safe_file(namespace / value['token'], root)
        token = token_path.read_text().strip()
        if not token:
            raise ValueError('discovery')
        prefix = '@runtime/'
        if not value['socket'].startswith(prefix):
            raise ValueError('discovery')
        socket_path = root / value['socket'][len(prefix):]
        if socket_path.parent.is_symlink() or socket_path.parent.parent != root / 's':
            raise ValueError('discovery')
        return {**value, 'token': token, 'socketPath': str(socket_path), 'namespacePath': str(namespace),
                'profileKey': profile_key, 'hubKey': hub_key}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise TransportError(str(error) if str(error) in ('expired', 'unsafe_file', 'path_escape') else 'discovery') from error

def request(socket_path, token, payload, timeout=5):
    if not isinstance(token, str) or not token:
        raise TransportError('token')
    data = json.dumps({**payload, 'token': token}, separators=(',', ':')).encode() + b'\n'
    if len(data) > MAX_FRAME:
        raise TransportError('frame_too_large')
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(socket_path)
        client.sendall(data)
        chunks, total = [], 0
        while True:
            block = client.recv(4096)
            if not block:
                break
            total += len(block)
            if total > MAX_RESPONSE:
                raise TransportError('response_too_large')
            chunks.append(block)
            if b'\n' in block:
                break
        try:
            response = json.loads(b''.join(chunks).split(b'\n', 1)[0])
        except Exception as error:
            raise TransportError('malformed_response') from error
        if not response.get('ok'):
            raise TransportError(response.get('error', 'monitor_unavailable'))
        return response
    except OSError as error:
        raise TransportError('offline') from error
    finally:
        client.close()

class MonitorTransport:
    """Bounded, authenticated UDS adapter; token is retained only in this instance."""
    def __init__(self, discovery, timeout=5):
        self.owner = discovery['owner']
        # Identity comes from validated discovery so admission can cross-check
        # a request against the Hub it actually reached, not a config copy.
        self.profile_key = discovery.get('profileKey')
        self.hub_instance_id = (discovery.get('lease') or {}).get('hub')
        self.socket_path = discovery['socketPath']
        self._token = discovery['token']
        self.timeout = timeout

    def _call(self, payload, timeout=None):
        return request(self.socket_path, self._token, payload, self.timeout if timeout is None else timeout)

    def events(self, cursor, limit=50, wait_ms=2000):
        """
        Long-poll for events. The read timeout must cover the wait window the
        Hub was asked to hold, otherwise every poll would expire locally and be
        journaled as an outage. The window stays short so a foreground SIGINT
        is observed promptly.
        """
        wait_ms = min(max(0, wait_ms), 25000)
        response = self._call({'type': 'events', 'afterSequence': cursor, 'limit': min(max(1, limit), 100),
                               'waitMs': wait_ms}, timeout=self.timeout + wait_ms / 1000)
        return response.get('events', response)

    def snapshot(self, task_id=None):
        response = self._call({'type': 'snapshot'})
        if task_id is None:
            return response
        snapshot = response.get('snapshot', response)
        tasks = snapshot.get('tasks', []) if isinstance(snapshot, dict) else []
        return [item for item in tasks if isinstance(item, dict) and item.get('id') == task_id]

    def invoke(self, payload):
        return self._call({**payload, 'type': 'invoke'})

    def cancel(self, task_id, generation):
        return self._call({'type': 'cancel', 'taskId': task_id, 'generation': generation})

    def invoke_recovery(self, task_id, generation):
        request = {'taskId': task_id, 'generation': generation, 'action': 'request_status',
                   'profileKey': self.profile_key, 'ownerSessionId': self.owner,
                   'hubInstanceId': self.hub_instance_id,
                   'parameters': {'assertionIds': [], 'evidenceEventIds': [],
                                  'instruction': 'Изпълни ограничено безопасно възстановяване и докладвай доказателства.'},
                   'basis': {'deviation': 'stalled_progress', 'judgment': 'confirmed'}}
        canonical = json.dumps(request, sort_keys=True, separators=(',', ':')).encode()
        request['requestId'] = 'recovery:' + __import__('hashlib').sha256(canonical).hexdigest()
        return self.invoke(request)


def reconcile(transport, cursor):
    try:
        return transport.events(cursor)
    except TransportError as error:
        if str(error) not in ('cursor_too_old', 'owner_changed'):
            raise
        snapshot = transport.snapshot()
        return {'snapshot': snapshot, 'events': [], 'cursor': 0, 'reconciled': True}
