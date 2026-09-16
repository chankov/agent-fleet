import json,os,subprocess,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts'))
from watchdog import _save_recovery,safe_invocation,run_watch
from datetime import datetime, timezone
import tempfile
class Cli(unittest.TestCase):
 def test_gate_lowers_tier(self): self.assertEqual(safe_invocation('{"autonomy":"steer","maximumAutonomy":"steer"}')[1],'observe')
 def test_one_foreground_pass_reconciles_events_and_releases_lock(self):
  class Transport:
   owner='owner'
   def events(self,cursor): return {'items':[{'eventSequence':1,'eventId':'hub:1','kind':'task.state_changed','occurredAt':datetime.now(timezone.utc).isoformat(),'task':{'id':'task','generation':1,'toState':'blocked'}}]}
   def snapshot(self): return {}
  with tempfile.TemporaryDirectory() as d:
   result=run_watch({'profileId':'p','stateDir':d,'lockDir':d,'hubInstanceId':'hub'},'observe',once=True,transport_factory=Transport)
   self.assertFalse(result['offline']); self.assertEqual(result['cursor'],1)
   self.assertFalse(list(Path(d).rglob('watch.lock')))
 def test_dangling_lock_path_symlinks_fail_closed_before_creating_or_chmodding_a_target(self):
  with tempfile.TemporaryDirectory() as d:
   profile='p'; profile_dir=__import__('hashlib').sha256(profile.encode()).hexdigest()
   for label in ('root', 'nested', 'per-profile'):
    with self.subTest(label):
     case=Path(d)/label; case.mkdir(); runtime=case/'runtime'; target=case/'missing'
     if label == 'root':
      link=runtime; lock_dir=link
     elif label == 'nested':
      runtime.mkdir(); os.chmod(runtime,0o700); link=runtime/'agent-fleet-hermes-watchdog'; lock_dir=runtime
     else:
      (runtime/'agent-fleet-hermes-watchdog').mkdir(parents=True); os.chmod(runtime,0o700); os.chmod(runtime/'agent-fleet-hermes-watchdog',0o700)
      link=runtime/'agent-fleet-hermes-watchdog'/profile_dir; lock_dir=runtime
     link.symlink_to(target, target_is_directory=True)
     invocation={'profileId':profile,'stateDir':d,'lockDir':str(lock_dir),'hubInstanceId':'hub'}
     result=subprocess.run([sys.executable,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts/watchdog.py'),'watch','--once','--invocation-json',json.dumps(invocation)],text=True,capture_output=True,check=False)
     self.assertEqual(result.returncode,2)
     self.assertEqual(json.loads(result.stdout),{'error':'unsafe_lock','ok':False})
     self.assertEqual(result.stderr,'')
     self.assertFalse(target.exists(), 'must not create or chmod a dangling-link target')

 def test_surgical_recovery_persists_independent_task_generation_transactions(self):
  gate={'originDelivery':True,'liveRunId':'live','api':{'kind':'argv','name':'hermes origin-update','argumentShape':'[route]'},'observations':{'opaqueOrigin':True,'threeIncrementalUpdates':True,'wakeReconnect':True,'profileIsolation':True,'twoChatIsolation':True,'structuredInvocation':True},'evidenceIds':['a','b']}
  records=[{'eventId':'hub:1','taskRef':{'taskId':'A','generation':3},'candidateDeviation':'stalled_progress'},{'eventId':'hub:2','taskRef':{'taskId':'B','generation':7},'candidateDeviation':'stalled_progress'}]
  class Transport:
   owner='owner'; profile_key='p'; hub_instance_id='hub'
   def events(self,cursor): return {'items':[{'eventSequence':1},{'eventSequence':2}]}
   def snapshot(self,task_id): return [{'generation':3 if task_id=='A' else 7,'state':'running','ownerSessionId':'owner'}]
   def cancel(self,task_id,generation): self.calls.append(('cancel',task_id,generation)); return {'cancelled':True}
   def __init__(self): self.calls=[]
  transport=Transport()
  with tempfile.TemporaryDirectory() as d, patch('watchdog.reduce_event',side_effect=lambda state,event,*_,**__: (state,[])), patch('watchdog.due_deviations',return_value=records), patch('watchdog._action_for',return_value=('none',None)):
   invocation={'profileId':'p','profileKey':'p','hubInstanceId':'hub','stateDir':d,'lockDir':d,'gateO':gate,'surgicalAllowlist':['A','B']}
   run_watch(invocation,'surgical',once=True,transport_factory=lambda:transport)
   self.assertEqual(transport.calls,[('cancel','A',3),('cancel','B',7)])
   _save_recovery(invocation,{'["A",3]':{'taskId':'A','generation':3,'kind':'native','ownerSessionId':'owner','profileKey':'p','hubInstanceId':'hub','state':'recovery_queued'},'["B",7]':{'taskId':'B','generation':7,'kind':'native','ownerSessionId':'owner','profileKey':'p','hubInstanceId':'hub','state':'proposed'}})
   transport.calls=[]
   with patch('watchdog.due_deviations',return_value=[records[1]]): run_watch(invocation,'surgical',once=True,transport_factory=lambda:transport)
  self.assertEqual(transport.calls,[('cancel','B',7)],'absorbing A cannot block persisted B')
