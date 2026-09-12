import unittest
from adapter import FleetMonitorAdapter, MonitorUnavailable
class Hub:
 def __init__(self,name,fail=False): self.name=name;self.fail=fail;self.calls=[]
 def snapshot(self):
  if self.fail: raise MonitorUnavailable('down')
  return {'tasks':[{'id':'same','generation':1}]}
 def output(self,*v): self.calls.append(('output',v));return {'text':self.name}
 def cancel(self,*v): self.calls.append(('cancel',v));return {'cancelled':True}
class MultiHubTest(unittest.TestCase):
 def test_colliding_ids_are_annotated_and_route_to_owner(self):
  a,b=Hub('a'),Hub('b'); f=FleetMonitorAdapter([('a',a),('b',b)])
  self.assertEqual({x['hubInstanceId'] for x in f.snapshot()['tasks']},{'a','b'})
  self.assertEqual(f.output('same',1,0,'b'),{'text':'b'}); self.assertEqual(b.calls,[('output',('same',1,0))]);self.assertEqual(a.calls,[])
 def test_failed_hub_does_not_drop_healthy_tasks(self):
  result=FleetMonitorAdapter([('a',Hub('a')),('b',Hub('b',True))]).snapshot();self.assertEqual(len(result['tasks']),1);self.assertEqual(result['hubs'][0]['hubInstanceId'],'b')
if __name__=='__main__': unittest.main()
