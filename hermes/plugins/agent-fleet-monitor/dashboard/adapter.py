"""Agent Fleet-owned, local-only monitor transport boundary.

Hermes supplies the FastAPI router; this adapter speaks only the source-owned
monitor UDS protocol and never controls Hermes, Pi, or Herdr lifecycle.
"""
import hashlib
import json
import os
import re
import socket
import stat
from datetime import datetime, timezone
from pathlib import Path

MAX_SNAPSHOT_RESPONSE_BYTES = 256 * 1024
MAX_CANCEL_RESPONSE_BYTES = 16 * 1024
MAX_OUTPUT_RESPONSE_BYTES = 2 * 1024 * 1024

class MonitorUnavailable(RuntimeError): pass

class MonitorAdapter:
    def __init__(self, socket_path: str, token: str) -> None:
        if not socket_path or not token or not os.path.isabs(socket_path):
            raise MonitorUnavailable("local monitor configuration is unavailable")
        self._socket_path, self._token = socket_path, token

    @classmethod
    def from_environment(cls, env: dict[str, str] | None = None) -> "MonitorAdapter":
        values = os.environ if env is None else env
        return cls(values.get("AGENT_FLEET_MONITOR_SOCKET", ""), values.get("AGENT_FLEET_MONITOR_TOKEN", ""))

    @staticmethod
    def canonical_profile_id(profile_id: str) -> str:
        # Matches Node's conservative human profile-ID validation and namespace hash.
        if not isinstance(profile_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", profile_id) or ".." in profile_id:
            raise MonitorUnavailable("monitor profile discovery is unavailable")
        return hashlib.sha256(profile_id.encode()).hexdigest()

    @classmethod
    def from_profile_environment(cls, env: dict[str, str] | None = None) -> "MonitorAdapter":
        values = os.environ if env is None else env
        profile_id, runtime = values.get("AGENT_FLEET_PROFILE_ID", ""), values.get("AGENT_FLEET_MONITOR_RUNTIME_DIR", "")
        if not os.path.isabs(runtime):
            raise MonitorUnavailable("monitor profile discovery is unavailable")
        profile_id = cls.canonical_profile_id(profile_id)
        try:
            root = Path(runtime)
            if root.is_symlink() or not root.is_dir() or stat.S_IMODE(root.stat().st_mode) != 0o700: raise ValueError()
            candidates = []
            for candidate in (root / profile_id).glob("*/discovery-*.json"):
                try:
                    candidate_stat = candidate.lstat()
                    if candidate.is_symlink() or not stat.S_ISREG(candidate_stat.st_mode) or stat.S_IMODE(candidate_stat.st_mode) != 0o600: raise ValueError()
                    item = json.loads(candidate.read_text())
                    lease = item["lease"]
                    if not isinstance(lease, dict) or not isinstance(item.get("owner"), str) or not re.fullmatch(r"[0-9a-f-]{36}", item["owner"], re.I) or not isinstance(item.get("token"), str) or not re.fullmatch(r"token-[0-9a-f-]{36}", item["token"], re.I) or not isinstance(item.get("socket"), str) or not re.fullmatch(r"@runtime/s/[0-9a-f]+/s", item["socket"]) or not isinstance(lease.get("hub"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", lease["hub"]) or type(lease.get("pid")) is not int or lease["pid"] < 1 or not isinstance(lease.get("startedAt"), str) or not isinstance(lease.get("expiresAt"), str): raise ValueError()
                    expected_token = f"token-{item['owner']}"
                    hub_hash = hashlib.sha256(lease['hub'].encode()).hexdigest()
                    expected_socket = "@runtime/s/" + hashlib.sha256(f"{profile_id}:{hub_hash}:{item['owner']}".encode()).hexdigest()[:32] + "/s"
                    if item['token'] != expected_token or item['socket'] != expected_socket: raise ValueError()
                    if datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                        token = item.get("token", "")
                        if isinstance(token, str) and token.startswith("token-") and "/" not in token: (candidate.parent / token).unlink(missing_ok=True)
                        candidate.unlink(missing_ok=True)
                        continue
                    candidates.append(candidate)
                except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
                    raise ValueError("monitor discovery metadata is malformed") from error
            if not candidates: raise ValueError()
            adapters = []
            for discovery_path in candidates:
                discovery = json.loads(discovery_path.read_text())
                lease = discovery["lease"]
                socket_ref, token_ref = discovery["socket"], discovery["token"]
                if not isinstance(socket_ref, str) or not socket_ref.startswith("@runtime/") or ".." in Path(socket_ref).parts: raise ValueError()
                if not isinstance(token_ref, str) or not token_ref.startswith("token-") or "/" in token_ref or ".." in token_ref: raise ValueError()
                token_path = discovery_path.parent / token_ref
                if token_path.is_symlink() or stat.S_IMODE(token_path.stat().st_mode) != 0o600: raise ValueError()
                adapters.append((lease["hub"], cls(str(root / socket_ref.removeprefix("@runtime/")), token_path.read_text().strip())))
            return FleetMonitorAdapter(adapters)
            discovery_path = candidates[0]
            if discovery_path.is_symlink() or stat.S_IMODE(discovery_path.stat().st_mode) != 0o600: raise ValueError()
            discovery = json.loads(discovery_path.read_text())
            lease = discovery["lease"]
            if not isinstance(lease, dict) or datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc): raise ValueError()
            socket_ref, token_ref = discovery["socket"], discovery["token"]
            if not isinstance(socket_ref, str) or not socket_ref.startswith("@runtime/") or ".." in Path(socket_ref).parts: raise ValueError()
            if not isinstance(token_ref, str) or not token_ref.startswith("token-") or "/" in token_ref or ".." in token_ref: raise ValueError()
            socket_path = root / socket_ref.removeprefix("@runtime/")
            token_path = discovery_path.parent / token_ref
            if token_path.is_symlink() or stat.S_IMODE(token_path.stat().st_mode) != 0o600: raise ValueError()
            return cls(str(socket_path), token_path.read_text().strip())
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise MonitorUnavailable("monitor profile discovery is unavailable") from error

    def _request(self, request: dict, max_response_bytes: int = MAX_SNAPSHOT_RESPONSE_BYTES) -> dict:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(2); client.connect(self._socket_path)
                client.sendall((json.dumps({**request, "token": self._token})+"\n").encode())
                data = b""
                while b"\n" not in data:
                    chunk = client.recv(min(8192, max_response_bytes + 1 - len(data)))
                    if not chunk: raise MonitorUnavailable("local monitor closed the response")
                    data += chunk
                    if len(data) > max_response_bytes + 1: raise MonitorUnavailable("local monitor response is too large")
                frame = data.split(b"\n", 1)[0]
                if len(frame) > max_response_bytes: raise MonitorUnavailable("local monitor response is too large")
                response = json.loads(frame)
                if not isinstance(response, dict): raise MonitorUnavailable("local monitor response is invalid")
                return response
        except (OSError, ValueError) as error:
            raise MonitorUnavailable("local monitor is unavailable") from error

    def snapshot(self) -> dict:
        response = self._request({"type": "snapshot"})
        if response.get("ok") is not True or not isinstance(response.get("snapshot"), dict):
            raise MonitorUnavailable("local monitor rejected the snapshot request")
        return response["snapshot"]

    def output(self, task_id: str, generation: int, after_sequence: int) -> dict:
        response = self._request({"type": "output", "taskId": task_id, "generation": generation, "afterSequence": after_sequence}, MAX_OUTPUT_RESPONSE_BYTES)
        if response.get("ok") is not True or not isinstance(response.get("output"), dict): raise MonitorUnavailable("local monitor rejected output")
        return response["output"]

    def cancel(self, task_id: str, generation: int) -> dict:
        if not task_id or not isinstance(generation, int):
            raise MonitorUnavailable("local monitor cancellation is invalid")
        response = self._request({"type": "cancel", "taskId": task_id, "generation": generation}, MAX_CANCEL_RESPONSE_BYTES)
        if response.get("ok") is not True or not isinstance(response.get("result"), dict):
            raise MonitorUnavailable("local monitor rejected cancellation")
        return response["result"]

class FleetMonitorAdapter:
    def __init__(self, hubs):
        self._hubs = dict(hubs)
        if len(self._hubs) == 1:
            only = next(iter(self._hubs.values()))
            self._socket_path, self._token = only._socket_path, only._token
    def snapshot(self):
        tasks, errors = [], []
        for hub_id, adapter in self._hubs.items():
            try:
                for task in adapter.snapshot().get("tasks", []): tasks.append({**task, "hubInstanceId": hub_id})
            except MonitorUnavailable: errors.append({"hubInstanceId": hub_id, "state": "orphaned", "error": "unavailable"})
        return {"tasks": tasks, "hubs": errors}
    def _hub(self, hub_instance_id):
        if not isinstance(hub_instance_id, str) or hub_instance_id not in self._hubs: raise MonitorUnavailable("local monitor hub is unavailable")
        return self._hubs[hub_instance_id]
    def output(self, task_id, generation, after_sequence, hub_instance_id): return self._hub(hub_instance_id).output(task_id, generation, after_sequence)
    def cancel(self, task_id, generation, hub_instance_id): return self._hub(hub_instance_id).cancel(task_id, generation)
