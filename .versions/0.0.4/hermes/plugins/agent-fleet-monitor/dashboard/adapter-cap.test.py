import json,socket,tempfile,threading,unittest
from pathlib import Path
from adapter import MonitorAdapter,MonitorUnavailable,MAX_SNAPSHOT_RESPONSE_BYTES
class CapTest(unittest.TestCase):
 def request(self, frame):
  with tempfile.TemporaryDirectory() as d:
   p=str(Path(d)/'s');s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(p);s.listen(1)
   def serve(): c,_=s.accept();c.recv(4096);c.sendall(frame);c.close();s.close()
   t=threading.Thread(target=serve);t.start()
   try:return MonitorAdapter(p,'t')._request({'type':'snapshot'})
   finally:t.join()
 def test_cap_excludes_one_ndjson_delimiter(self):
  base=json.dumps({'x':''},separators=(',',':')).encode();frame=json.dumps({'x':'a'*(MAX_SNAPSHOT_RESPONSE_BYTES-len(base))},separators=(',',':')).encode();self.assertEqual(len(frame),MAX_SNAPSHOT_RESPONSE_BYTES);self.assertIsInstance(self.request(frame+b'\n'),dict)
  with self.assertRaises(MonitorUnavailable):self.request(frame+b'a\n')
if __name__=='__main__':unittest.main()
