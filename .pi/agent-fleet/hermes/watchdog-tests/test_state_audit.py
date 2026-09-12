import sys,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts'))
from watchdog_state import atomic_json,load_json,audit
class StateAudit(unittest.TestCase):
 def test_round_trip_and_redaction(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'state'; atomic_json(p,{'x':1}); self.assertEqual(load_json(p),{'x':1}); self.assertTrue(audit(Path(d)/'audit',{'decision':'observe'}).startswith('sha256:'))
   with self.assertRaises(ValueError): audit(Path(d)/'bad',{'token':'no'})
 def test_audit_is_hash_linked_ndjson_and_allows_route_deviation(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'audit.ndjson'
   first=audit(p,{'deviation':'route_unavailable','taskRef':{'taskId':'run-route-1','generation':1}})
   second=audit(p,{'decision':'observe'})
   rows=[__import__('json').loads(line) for line in p.read_text().splitlines()]
   self.assertEqual(len(rows),2)
   self.assertEqual(rows[1]['previousHash'],first)
   self.assertEqual(rows[1]['recordHash'],second)
 def test_unsafe_mode_and_tampered_journal_fail_closed(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'audit.ndjson'; audit(p,{'decision':'observe'}); p.chmod(0o644)
   with self.assertRaises(ValueError): audit(p,{'decision':'observe'})
   p.chmod(0o600); p.write_text('{bad}\n')
   with self.assertRaises(ValueError): audit(p,{'decision':'observe'})
 def test_compaction_relinks_the_surviving_hash_chain_after_more_than_1000_appends(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'audit.ndjson'
   for n in range(1002): audit(p,{'decision':'observe','occurredAt':f'2099-01-01T00:00:{n % 60:02d}Z'})
   # A subsequent append must validate the compacted chain instead of self-reporting tampering.
   audit(p,{'decision':'observe'})
   rows=[__import__('json').loads(line) for line in p.read_text().splitlines()]
   self.assertEqual(rows[0]['previousHash'],'')
   self.assertLessEqual(len(rows),1000)
