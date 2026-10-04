import sys,unittest
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts'))
from watchdog_engine import reduce_event,due_deviations,drain_offline,DEVIATIONS

def event(n,kind,**extra):
 e={'eventSequence':n,'eventId':f'h:{n}','kind':kind,'occurredAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'task':{'id':'t','generation':1}}
 e.update(extra); return e

class Engine(unittest.TestCase):
 def test_all_canonical_rule_candidates_are_deterministic(self):
  cases=[('task.state_changed',{'task':{'id':'t','generation':1,'toState':'blocked'}},'blocked_waiting_human'),('task.state_changed',{'task':{'id':'t','generation':1,'toState':'failed'}},'repeated_failure'),('hub.capability_changed',{},'capacity_mismatch'),('owner.orphaned',{},'owner_offline'),('owner.recovering',{},'recovery_loop'),('task.generation_superseded',{},'stale_generation'),('action.rejected',{},'unsafe_action_request'),('hub.queue_depth_changed',{'queueDepth':1},'queue_starvation'),('task.output_advanced',{'completionIntent':True,'assertionEvidence':False},'verification_gap'),('task.output_advanced',{'scopeWatchdog':True},'scope_drift'),('task.output_advanced',{'researchMissing':True},'research_gap'),('route.unavailable',{},'route_unavailable')]
  for n,(kind,extra,want) in enumerate(cases,1):
   state,out=reduce_event({},event(n,kind,**extra),n*100)
   self.assertEqual(out[0]['candidateDeviation'],want)
  self.assertEqual(DEVIATIONS,{'stalled_progress','silent_progress','blocked_waiting_human','verification_gap','scope_drift','repeated_failure','research_gap','queue_starvation','capacity_mismatch','recovery_loop','owner_offline','stale_generation','route_unavailable','unsafe_action_request'})
 def test_duplicate_reorder_stale_and_newer_generation_are_non_actionable(self):
  state,out=reduce_event({},event(2,'task.state_changed',task={'id':'t','generation':2,'toState':'blocked'}),10)
  self.assertEqual(out[0]['candidateDeviation'],'blocked_waiting_human')
  self.assertEqual(reduce_event(state,event(2,'task.state_changed',task={'id':'t','generation':2,'toState':'blocked'}),11)[1],[])
  self.assertEqual(reduce_event(state,event(1,'task.state_changed',task={'id':'t','generation':1,'toState':'failed'}),12)[1],[])
  _,late=reduce_event({},event(1,'task.state_changed',occurredAt='1970-01-01T00:00:00Z',task={'id':'t','generation':1,'toState':'failed'}),121)
  self.assertEqual(late[0]['candidateDeviation'],None); self.assertTrue(late[0]['stale'])
 def test_output_coalescing_throttles_route_and_monotonic_rollback(self):
  state,out=reduce_event({},event(1,'task.output_advanced',scopeWatchdog=True),10); self.assertEqual(len(out),1)
  self.assertEqual(reduce_event(state,event(2,'task.output_advanced',scopeWatchdog=True),11)[1],[])
  state,out=reduce_event(state,event(3,'task.output_advanced',scopeWatchdog=True),13); self.assertEqual(out,[],'warning cooldown is 15 seconds')
  state,out=reduce_event(state,event(4,'task.output_advanced',scopeWatchdog=True),30); self.assertEqual(len(out),1)
  state,out=reduce_event(state,event(5,'task.output_advanced',scopeWatchdog=True),1); self.assertEqual(out,[],'clock rollback cannot reopen cooldown')
 def test_stall_silent_and_offline_buffer_are_bounded(self):
  state,_=reduce_event({},event(1,'task.started'),0)
  self.assertEqual(due_deviations(state,600)[0]['candidateDeviation'],'stalled_progress')
  state,_=reduce_event({},event(2,'task.output_advanced'),700)
  self.assertEqual(due_deviations(state,1300)[0]['candidateDeviation'],'silent_progress')
  for n in range(3,130): state,_=reduce_event(state,event(n,'task.state_changed',task={'id':f't{n}','generation':1,'toState':'blocked'}),n*100,online=False)
  state,offline=drain_offline(state); self.assertLessEqual(len(offline),100); self.assertEqual(state['offline_bytes'],0)
if __name__=='__main__': unittest.main()
