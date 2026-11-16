import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts'))
from watchdog_judgment import request,response
class Judgment(unittest.TestCase):
 def test_bounds_and_forgery_fail_closed(self):
  with self.assertRaises(ValueError): request('x',['a']*21)
  self.assertEqual(response({'confidence':1},'x',['a'])['recommendedAction'],'none')
 def test_valid_response_and_bool_confidence_are_distinct(self):
  valid={'deviation':'scope_drift','verdict':'confirmed','confidence':.9,'recommendedAction':'narrow_scope','evidenceEventIds':['e1']}
  self.assertEqual(response(valid,'scope_drift',['e1'])['recommendedAction'],'narrow_scope')
  self.assertEqual(response({**valid,'confidence':True},'scope_drift',['e1'])['recommendedAction'],'none')
 def test_output_and_evidence_redaction_bounds(self):
  with self.assertRaises(ValueError): request('x',['route-secret'])
  with self.assertRaises(ValueError): request('x',['a'],'x'*4097)
  with self.assertRaises(ValueError): request('x',['x'*9000])
 def test_judgment_cannot_escalate_or_override_a_none_cap(self):
  self.assertEqual(request('verification_gap',['e1'])['allowedRecommendations'],['none','request_verification'])
  forged={'deviation':'blocked_waiting_human','verdict':'confirmed','confidence':.9,'recommendedAction':'request_status','evidenceEventIds':['e1']}
  self.assertEqual(response(forged,'blocked_waiting_human',['e1'])['recommendedAction'],'none')
