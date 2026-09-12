import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('fleet_read', Path(__file__).with_name('fleet-codex-read.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class Reads(unittest.TestCase):
    def test_reload_resync_recovers_exact_late_reply(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / reader.activity.slug_for_cwd('/repo'); folder.mkdir()
            transcript = folder / 'reload.jsonl'
            records = [
                {'type':'custom','customType':'coms-log','data':{'event':'boot','session_id':'old'}},
                {'padding':'x' * (300 * 1024)},
                {'type':'custom','customType':'coms-log','data':{'event':'boot','session_id':'current'}},
                {'type':'message','message':{'role':'assistant','content':[{'type':'text','text':'FINAL_BLUE'}]}},
                {'type':'custom','customType':'coms-log','data':{'event':'outbound_response_failed','msg_id':'wire-reload'}}]
            transcript.write_text(''.join(json.dumps(r)+'\n' for r in records))
            with patch.object(reader.activity, 'sessions_root', return_value=root), \
                 patch.object(reader, 'read_pane', return_value={}), \
                 patch.object(reader, 'read_monitor', return_value={'available':False,'gap':True,'cursor':{}}):
                result = reader.read({'entry':{'cwd':'/repo','session_id':'current','name':'hub'},'project':'af','pending':['wire-reload']})
            self.assertTrue(result['activity']['available'])
            self.assertEqual(result['replies'], [{'wireId':'wire-reload','state':'result','result':'FINAL_BLUE','truncated':False}])

    def test_activity_identity_gap_and_no_thinking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / reader.activity.slug_for_cwd('/repo'); folder.mkdir()
            transcript = folder / 'session.jsonl'
            records = [{'type':'custom','customType':'coms-log','data':{'event':'boot','session_id':'one','name':'hub','project':'af'}},
                       {'type':'message','timestamp':'2026-09-08T10:00:00Z','message':{'role':'assistant','content':[{'type':'thinking','thinking':'PRIVATE'},{'type':'text','text':'Result BLUE'}],'stopReason':'stop'}}]
            transcript.write_text(''.join(json.dumps(r)+'\n' for r in records))
            entry = {'cwd':'/repo','session_id':'one','name':'hub'}
            first = reader.read_activity(entry, {}, root)
            self.assertTrue(first['available']); self.assertNotIn('PRIVATE', json.dumps(first))
            again = reader.read_activity(entry, first['cursor'], root)
            self.assertEqual(again['steps'], [])
            self.assertTrue(reader.read_activity(entry, {'identity':'old','seq':999999}, root)['gap'])
            self.assertFalse(reader.read_activity({**entry,'session_id':'other'}, {}, root)['available'])
    def test_late_reply_uses_exact_audit_id_and_ignores_thinking(self):
        rows = [(1,json.dumps({'type':'message','message':{'role':'assistant','content':[{'type':'thinking','thinking':'private'},{'type':'text','text':'BLUE'}]}})),
                (2,json.dumps({'type':'custom','customType':'coms-log','data':{'event':'outbound_response_failed','msg_id':'wire-one'}}))]
        self.assertEqual(reader.project_replies(rows, ['wire-one'])[0]['result'], 'BLUE')
        self.assertEqual(reader.project_replies(rows, ['another']), [])
        self.assertEqual(reader.project_replies(rows[1:], ['wire-one']), [])

    def test_tasks_isolate_owner_and_generations(self):
        tasks = [{'id':'p','generation':1,'ownerSessionId':'owner','kind':'parent'},
                 {'id':'child','generation':1,'ownerSessionId':'owner','kind':'child','parentId':'p','parentGeneration':1},
                 {'id':'child','generation':2,'ownerSessionId':'owner','kind':'child','parentId':'p','parentGeneration':1},
                 {'id':'alien','generation':1,'ownerSessionId':'other','kind':'child'}]
        calls=[]
        class Monitor:
            def _call(self, args):
                calls.append(args)
                return {'output': {'text':'hello', 'sequence':1, 'firstSequence':1, 'truncated':False}}
        result = reader.read_tasks(Monitor(), tasks, 'owner', 'hub', {})
        self.assertEqual(len(result['tasks']),3)
        self.assertEqual(len(result['cursor']),3)
        self.assertNotIn('alien', json.dumps(result))
        self.assertEqual(len(calls),3)
    def test_output_budget_is_explicit_and_next_resync_catches_up(self):
        tasks = [{'id':str(i),'generation':1,'ownerSessionId':'o','outputSequence':1} for i in range(9)]
        class Monitor:
            def _call(self, args): return {'output':{'text':'ok','sequence':1,'firstSequence':1,'truncated':False}}
        first = reader.read_tasks(Monitor(), tasks, 'o', 'h', {})
        self.assertEqual(first['pendingOutputs'], 1)
        second = reader.read_tasks(Monitor(), tasks, 'o', 'h', first['cursor'])
        self.assertEqual(second['pendingOutputs'], 0)
        self.assertEqual(len(second['cursor']), 9)

    def test_ambiguous_pane_not_selected(self):
        a={'agent':'pi','pane_id':'p1','tokens':{'proj':'af','coms':'hub'},'agent_status':'working'}
        with patch.object(reader.herdr_source,'list_agents',return_value=[a,{**a,'pane_id':'p2'}]):
            self.assertIsNone(reader.read_pane('af','hub')['paneId'])

if __name__ == '__main__': unittest.main()
