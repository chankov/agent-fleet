import json,os,tempfile,unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from adapter import MonitorAdapter,MonitorUnavailable
class ForgedOwnerTest(unittest.TestCase):
 def test_forged_cross_owner_expired_record_is_not_cleaned(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'r';root.mkdir(mode=0o700);p='p';ns=root/MonitorAdapter.canonical_profile_id(p)/('a'*64);ns.mkdir(parents=True,mode=0o700);owner='00000000-0000-0000-0000-000000000000';f=ns/f'discovery-{owner}.json';f.write_text(json.dumps({'owner':owner,'token':'token-11111111-1111-1111-1111-111111111111','socket':'@runtime/s/'+'a'*32+'/s','lease':{'hub':'hub','pid':1,'startedAt':'2020-01-01T00:00:00Z','expiresAt':'2020-01-01T00:00:01Z'}}));os.chmod(f,0o600)
   with self.assertRaises(MonitorUnavailable):MonitorAdapter.from_profile_environment({'AGENT_FLEET_PROFILE_ID':p,'AGENT_FLEET_MONITOR_RUNTIME_DIR':str(root)})
   self.assertTrue(f.exists())
if __name__=='__main__':unittest.main()
