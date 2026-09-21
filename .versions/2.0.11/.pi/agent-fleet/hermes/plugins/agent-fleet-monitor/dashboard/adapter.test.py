import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from adapter import MonitorAdapter, MonitorUnavailable


class AdapterTest(unittest.TestCase):
    def test_hex_looking_profile_id_is_still_hashed(self):
        value = "a" * 64
        self.assertNotEqual(MonitorAdapter.canonical_profile_id(value), value)
    def test_reads_only_authenticated_snapshot_from_unix_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = str(Path(directory) / "monitor.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(socket_path)
            server.listen(1)
            def serve():
                client, _ = server.accept()
                request = json.loads(client.recv(4096).decode())
                self.assertEqual(request, {"type": "snapshot", "token": "secret"})
                client.sendall(b'{"ok":true,"snapshot":{"tasks":[]}}\n')
                client.close()
                server.close()
            thread = threading.Thread(target=serve)
            thread.start()
            self.assertEqual(MonitorAdapter(socket_path, "secret").snapshot(), {"tasks": []})
            thread.join()

    def test_refuses_missing_local_configuration(self):
        with self.assertRaises(MonitorUnavailable):
            MonitorAdapter.from_environment({})


if __name__ == "__main__":
    unittest.main()
