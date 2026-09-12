import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from adapter import MonitorAdapter

class AdapterDiscoveryTest(unittest.TestCase):
    def test_discovers_local_socket_and_token_from_explicit_profile_runtime_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/"runtime"; root.mkdir(mode=0o700)
            profile="a"*64; namespace=root/MonitorAdapter.canonical_profile_id(profile)/("b"*64); namespace.mkdir(parents=True, mode=0o700)
            owner="00000000-0000-0000-0000-000000000000"; socket_id=__import__('hashlib').sha256(f"{MonitorAdapter.canonical_profile_id(profile)}:{__import__('hashlib').sha256(b'hub').hexdigest()}:{owner}".encode()).hexdigest()[:32]; token=namespace/f"token-{owner}"; token.write_text("secret"); os.chmod(token,0o600)
            discovery=namespace/f"discovery-{owner}.json"; discovery.write_text(json.dumps({"owner":owner,"socket":f"@runtime/s/{socket_id}/s","token":f"token-{owner}","lease":{"hub":"hub","pid":1,"startedAt":"2020-01-01T00:00:00Z","expiresAt":(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()}})); os.chmod(discovery,0o600)
            adapter=MonitorAdapter.from_profile_environment({"AGENT_FLEET_PROFILE_ID":profile,"AGENT_FLEET_MONITOR_RUNTIME_DIR":str(root)})
            self.assertEqual(adapter._socket_path,str(root/f"s/{socket_id}/s")); self.assertEqual(adapter._token,"secret")

if __name__ == "__main__": unittest.main()
