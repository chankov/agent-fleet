#!/usr/bin/env python3
"""Bounded read-only adapter; reuses Hermes readers without importing its server."""
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'hermes/plugins/agent-fleet-herdr/dashboard'))
sys.path.insert(0, str(ROOT / 'hermes/skills/hub-watchdog/scripts'))
import activity
import herdr_source
from watchdog_transport import discover, MonitorTransport


def read_pane(project, peer):
    try:
        matches = [a for a in herdr_source.list_agents() if herdr_source.peer_key(a) == (project, peer) and a.get('agent') == 'pi']
        if len(matches) != 1:
            return {'paneId':None, 'state':'unknown', 'reason':'ambiguous' if matches else 'unavailable'}
        a = matches[0]
        return {'paneId':a.get('pane_id'), 'state':herdr_source.normalize_state(a.get('agent_status')), 'reason':''}
    except herdr_source.HerdrUnavailable:
        return {'paneId':None, 'state':'unknown', 'reason':'herdr unavailable'}


def read_activity(entry, cursor, root=None):
    transcript, reason = activity.transcript_for_entry(entry, root=root)
    if transcript is None:
        return {**activity.unavailable(reason), 'cursor':cursor, 'gap':True}
    info = transcript.stat()
    identity = hashlib.sha256(f'{transcript}:{info.st_dev}:{info.st_ino}'.encode()).hexdigest()
    after = cursor.get('seq', 0)
    reset = bool(cursor) and (cursor.get('identity') != identity or after > info.st_size)
    if reset: after = 0
    steps = activity.steps_for_path(transcript)
    fresh = [s for s in steps if s['seq'] > after]
    result = activity.activity_for_entry(entry, after=after, limit=50, root=root)
    # The canonical reader trims to newest whole lines. Surface that loss explicitly.
    gap = reset or (info.st_size > activity.TAIL_BYTES and after < max(0, info.st_size-activity.TAIL_BYTES)) or len(fresh) > len(result['steps'])
    return {**result, 'gap':gap, 'cursor':{'identity':identity, 'seq':result['seq']}, 'source':'pi_transcript'}


TASK_FIELDS = ('id','generation','kind','state','specialist','parentId','parentGeneration','updatedAt','outputSequence')

def read_tasks(transport, tasks, owner, hub, cursors):
    selected = [t for t in tasks if t.get('ownerSessionId') == owner]
    # Fair bounded window: oldest unread outputs first, then current task metadata.
    selected.sort(key=lambda t: (cursors.get(f"{owner}:{hub}:{t['id']}:{t['generation']}", 0) >= t.get('outputSequence', 0), t.get('updatedAt','')))
    results, next_cursors, gap = [], dict(cursors), len(selected) > 100
    reads, pending = 0, 0
    for task in selected[:100]:
        item = {k:task[k] for k in TASK_FIELDS if k in task}
        item.update(ownerSessionId=owner, hubInstanceId=hub)
        key = f"{owner}:{hub}:{task['id']}:{task['generation']}"
        after = cursors.get(key, 0)
        if reads < 8 and (key not in cursors or task.get('outputSequence', 0) > after):
            reads += 1
            try:
                output = transport._call({'type':'output','taskId':task['id'],'generation':task['generation'],'afterSequence':after})['output']
                text = output.get('text', '')
                item['output'] = text[-32768:]
                item['outputGap'] = bool(output.get('truncated') or len(text) > 32768 or output.get('firstSequence', 0) > after + 1)
                gap = gap or item['outputGap']
                next_cursors[key] = output.get('sequence', after)
            except Exception:
                item['outputUnavailable'] = True; gap = True
        if reads >= 8 and (key not in next_cursors or task.get('outputSequence',0) > next_cursors.get(key,0)):
            item['outputDeferred'] = True; pending += 1
        results.append(item)
    active_keys = {f"{owner}:{hub}:{t['id']}:{t['generation']}" for t in selected}
    return {'tasks':results, 'pendingOutputs':pending, 'cursor':{k:v for k,v in next_cursors.items() if k in active_keys}, 'gap':gap}


def read_monitor(entry, cursor, wait_ms=0):
    runtime = Path(os.environ.get('AGENT_FLEET_MONITOR_RUNTIME_DIR', f'/tmp/agent-fleet-monitor-{os.getuid()}'))
    profile = os.environ.get('AGENT_FLEET_PROFILE_ID')
    pattern = (hashlib.sha256(profile.encode()).hexdigest() if profile else '*') + '/*/discovery-*.json'
    candidates = []
    try:
        if runtime.is_symlink() or runtime.stat().st_uid != os.getuid(): raise ValueError()
        paths = list(islice(runtime.glob(pattern), 33))
        if len(paths) > 32: raise ValueError()
        for p in paths:
            try:
                d = discover(str(runtime), p.parent.parent.name, p.parent.name, datetime.now(timezone.utc))
                if d['lease'].get('pid') == entry['pid']: candidates.append(d)
            except Exception:
                continue
    except Exception:
        return {'available':False, 'reason':'monitor discovery unavailable', 'tasks':[], 'cursor':cursor, 'gap':True}
    if len(candidates) != 1:
        return {'available':False, 'reason':'monitor missing or ambiguous for selected Pi process', 'tasks':[], 'cursor':cursor, 'gap':True}
    d = candidates[0]; transport = MonitorTransport(d, timeout=2)
    owner = d['owner']; hub = d['lease']['hub']
    reset = bool(cursor) and cursor.get('owner') != owner
    previous = {} if reset else cursor
    gap = reset
    try:
        if wait_ms: time.sleep(min(wait_ms, 2000)/1000)
        snap = transport.snapshot()['snapshot']
        tasks = read_tasks(transport, snap.get('tasks',[]), owner, hub, previous.get('outputs',{}))
        return {'available':True, 'source':'hub_monitor', 'tasks':tasks['tasks'], 'pendingOutputs':tasks['pendingOutputs'], 'gap':gap or tasks['gap'],
                'cursor':{'owner':owner,'outputs':tasks['cursor']}}
    except Exception:
        return {'available':False, 'reason':'monitor unavailable', 'tasks':[], 'cursor':cursor, 'gap':True}


def project_replies(rows, pending):
    """Match Pi's own respond() audit to the assistant text it used, never a guessed next turn."""
    replies, latest = [], None
    wanted = set(pending)
    for _, line in rows:
        try: record = json.loads(line)
        except ValueError: continue
        if record.get('type') == 'message' and record.get('message',{}).get('role') == 'assistant':
            content = record['message'].get('content')
            if isinstance(content,str): latest = content
            elif isinstance(content,list): latest = '\n'.join(c['text'] for c in content if c.get('type') == 'text' and isinstance(c.get('text'),str))
        data = record.get('data',{})
        if record.get('customType') == 'coms-log' and data.get('event') in ('outbound_response','outbound_response_failed') and data.get('msg_id') in wanted and latest is not None:
            replies.append({'wireId':data['msg_id'], 'state':'failed' if data.get('error') else 'result', 'result':latest[:16000], 'truncated':len(latest)>16000})
    return replies


def read(request):
    entry = request['entry']; cursor = request.get('cursor') or {}
    pane = read_pane(request['project'], entry['name'])
    transcript = read_activity(entry, cursor.get('activity',{}))
    monitor = read_monitor(entry, cursor.get('monitor',{}), request.get('waitMs',0))
    path, _ = activity.transcript_for_entry(entry)
    replies = project_replies(activity.read_tail(path), request.get('pending', [])) if path else []
    return {'replies':replies, 'observedAt':datetime.now(timezone.utc).isoformat(), 'pane':pane, 'activity':transcript, 'monitor':monitor,
            'partial':not transcript['available'] or not monitor['available'] or transcript['gap'] or monitor['gap'] or bool(monitor.get('pendingOutputs')), 
            'cursor':{'activity':transcript['cursor'],'monitor':monitor['cursor']}}

if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        print(json.dumps(read(request), ensure_ascii=False))
    except Exception:
        print(json.dumps({'error':'read sources unavailable'})); sys.exit(1)
