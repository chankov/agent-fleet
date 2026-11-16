"""Private, owner-only watcher state and append-only decision audit."""
import hashlib
import json
import os
import stat
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

AUDIT_LIMIT = 1000
AUDIT_DAYS = 7


def _safe(path):
    path = Path(path)
    if path.exists():
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode) or mode & 0o077:
            raise ValueError('unsafe_state')


def _safe_parent(path):
    parent = Path(path).parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = parent.lstat().st_mode
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or mode & 0o077:
        raise ValueError('unsafe_state')


def atomic_json(path, value):
    path = Path(path)
    _safe_parent(path)
    _safe(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_json(path):
    _safe(path)
    return json.loads(Path(path).read_text(encoding='utf-8'))


def _audit_record(record, previous, sequence):
    if not isinstance(record, dict):
        raise ValueError('sensitive_audit')
    # Store only correlation and decision fields: no raw route/output/prompt/token fields.
    allowed = {'watchId', 'hubInstanceId', 'taskRef', 'eventIds', 'deviation', 'tier',
               'decision', 'requestId', 'parametersDigest', 'recoveryState', 'occurredAt'}
    if set(record) - allowed:
        raise ValueError('sensitive_audit')
    task = record.get('taskRef')
    if task is not None and (not isinstance(task, dict) or set(task) - {'taskId', 'generation'}):
        raise ValueError('sensitive_audit')
    event_ids = record.get('eventIds')
    if event_ids is not None and (not isinstance(event_ids, list) or not all(isinstance(item, str) for item in event_ids)):
        raise ValueError('sensitive_audit')
    clean = {key: value for key, value in record.items() if value is not None}
    clean.update({'schema': 'agent-fleet.watchdog-audit', 'schemaVersion': 1,
                  'authority': 'watcher_decision_trace', 'auditSequence': sequence,
                  'occurredAt': clean.get('occurredAt') or datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                  'previousHash': previous})
    body = json.dumps(clean, sort_keys=True, separators=(',', ':'))
    clean['recordHash'] = 'sha256:' + hashlib.sha256((previous + body).encode()).hexdigest()
    return clean


def _read_audit(path):
    _safe(path)
    if not Path(path).exists():
        return []
    rows = []
    previous = ''
    for index, line in enumerate(Path(path).read_text(encoding='utf-8').splitlines(), 1):
        try:
            row = json.loads(line)
            if row.get('previousHash') != previous or not isinstance(row.get('recordHash'), str):
                raise ValueError('audit_tampered')
            copy = dict(row); actual = copy.pop('recordHash')
            body = json.dumps(copy, sort_keys=True, separators=(',', ':'))
            expected = 'sha256:' + hashlib.sha256((previous + body).encode()).hexdigest()
            if actual != expected:
                raise ValueError('audit_tampered')
            previous = actual
            rows.append(row)
        except (ValueError, json.JSONDecodeError) as error:
            # A final torn line is recoverable only if it is the final physical record.
            if index and index == len(Path(path).read_text(encoding='utf-8').splitlines()) and not line.strip():
                break
            raise ValueError('audit_tampered') from error
    return rows


def _retain(rows):
    cutoff = datetime.now(timezone.utc) - timedelta(days=AUDIT_DAYS)
    retained = []
    for row in rows:
        try:
            timestamp = datetime.fromisoformat(row['occurredAt'].replace('Z', '+00:00'))
        except (KeyError, ValueError):
            raise ValueError('audit_tampered')
        pending = row.get('recoveryState') in {'proposed', 'cancelling', 'cancel_observed'}
        if pending or timestamp >= cutoff:
            retained.append(row)
    normal = [row for row in retained if row.get('recoveryState') not in {'proposed', 'cancelling', 'cancel_observed'}]
    pending = [row for row in retained if row not in normal]
    return pending + normal[-AUDIT_LIMIT:]


def _rehash(rows):
    """Compaction creates a new self-contained chain; never retain a deleted predecessor hash."""
    previous = ''
    compacted = []
    for row in rows:
        copy = dict(row)
        copy.pop('recordHash', None)
        copy['previousHash'] = previous
        body = json.dumps(copy, sort_keys=True, separators=(',', ':'))
        copy['recordHash'] = 'sha256:' + hashlib.sha256((previous + body).encode()).hexdigest()
        previous = copy['recordHash']
        compacted.append(copy)
    return compacted


def audit(path, record, previous=''):
    """Append one fsynced hash-linked NDJSON record and return its record hash."""
    path = Path(path)
    _safe_parent(path)
    rows = _read_audit(path)
    prior = rows[-1]['recordHash'] if rows else previous
    row = _audit_record(record, prior, len(rows) + 1)
    rows = _retain(rows + [row])
    # Rewrite atomically so compaction cannot leave a partially appended chain.
    # If records were removed their old predecessor is gone, therefore re-link.
    rows = _rehash(rows)
    payload = '\n'.join(json.dumps(item, sort_keys=True, separators=(',', ':')) for item in rows) + '\n'
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path); os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return row['recordHash']


def profile_root(base, profile):
    return Path(base) / hashlib.sha256(profile.encode()).hexdigest()
