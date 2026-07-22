import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from adapter import MonitorAdapter


class AdapterOutputTest(unittest.TestCase):
    def test_maps_typed_output_route_to_authenticated_uds_cursor_request(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = str(Path(directory) / "monitor.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(socket_path)
            server.listen(1)

            def serve():
                client, _ = server.accept()
                request = json.loads(client.recv(4096).decode())
                self.assertEqual(request, {"type": "output", "token": "secret", "taskId": "task", "generation": 2, "afterSequence": 7})
                client.sendall(b'{"ok":true,"output":{"text":"new","sequence":8,"firstSequence":8,"truncated":false}}\n')
                client.close()
                server.close()

            thread = threading.Thread(target=serve)
            thread.start()
            self.assertEqual(MonitorAdapter(socket_path, "secret").output("task", 2, 7), {"text": "new", "sequence": 8, "firstSequence": 8, "truncated": False})
            thread.join()


if __name__ == "__main__":
    unittest.main()
