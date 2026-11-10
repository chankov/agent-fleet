import json,os,tempfile,unittest
from pathlib import Path
from adapter import MonitorAdapter,MonitorUnavailable
class LeaseListTest(unittest.TestCase):
 def test_lease_list_is_unavailable(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'r';root.mkdir(mode=0o700); profile='p';ns=root/MonitorAdapter.canonical_profile_id(profile)/('a'*64);ns.mkdir(parents=True,mode=0o700);p=ns/'discovery-00000000-0000-0000-0000-000000000000.json';p.write_text(json.dumps({'lease':[]}));os.chmod(p,0o600)
   with self.assertRaises(MonitorUnavailable):MonitorAdapter.from_profile_environment({'AGENT_FLEET_PROFILE_ID':profile,'AGENT_FLEET_MONITOR_RUNTIME_DIR':str(root)})
if __name__=='__main__':unittest.main()
