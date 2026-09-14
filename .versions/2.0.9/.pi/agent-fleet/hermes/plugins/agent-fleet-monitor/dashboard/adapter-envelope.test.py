import socket,tempfile,threading,unittest
from pathlib import Path
from adapter import MonitorAdapter,MonitorUnavailable
class EnvelopeTest(unittest.TestCase):
 def test_rejects_non_object_json_envelope(self):
  with tempfile.TemporaryDirectory() as d:
   p=str(Path(d)/'s'); server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(p);server.listen(1)
   def serve():
    c,_=server.accept();c.recv(4096);c.sendall(b'[]\n');c.close();server.close()
   t=threading.Thread(target=serve);t.start()
   with self.assertRaises(MonitorUnavailable): MonitorAdapter(p,'secret').snapshot()
   t.join()
if __name__=='__main__':unittest.main()
