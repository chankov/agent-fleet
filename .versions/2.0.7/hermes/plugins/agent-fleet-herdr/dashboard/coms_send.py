"""The write half — hand a prompt to a live coms peer and keep its answer.

This is the one module in the plugin that is not read-only, so its boundaries
are drawn tightly:

  - the renderer never names an ENDPOINT, only `(project, name)`. The socket
    path is looked up here, from the registry, and never travels outward. A
    renderer running with the full privileges of the app must not also be
    holding write doors into other agents' processes.
  - `project` and `name` are validated against the same character classes the
    TS side enforces (coms-envelope.ts), before either touches a path.
  - delivery is fire-and-forget. The peer answers on its own schedule — minutes,
    for anything worth asking — so the HTTP request returns as soon as the
    prompt is ACKed, and the answer arrives later on the reply socket opened for
    it. A panel that polls every 3s must never hold a request open for minutes.

Wire format is coms-envelope.ts exactly: one JSON object per line over a unix
socket, answered with a single `ack`/`nack` line. Any drift here is a protocol
break, not a refactor.

State: replies live in memory, bounded and per-process. A gateway restart loses
the transcript — the agent's own pane has it, and this pane is a fleet view, not
a message store.
"""

import json
import os
import re
import secrets
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import coms_registry

# Mirrors COMS_PROJECT_SAFE / COMS_NAME_SAFE in scripts/lib/coms-envelope.ts.
_PROJECT_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_NAME_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

# Who the fleet sees this dispatch as. Deliberately not a registered peer: the
# panel is a window onto the pool, not a member of it, and registering would put
# it in everyone's `coms_list`.
SENDER_NAME = "hermes-panel"

# LINE_CAP_BYTES in coms-envelope.ts is 64 KiB for the WHOLE envelope; leave
# room for the ~600 bytes of framing around the prompt.
MAX_PROMPT_CHARS = 32_000

# How long a reply socket waits before giving up and cleaning itself up. Long
# turns are normal; an abandoned socket is not.
REPLY_TTL_S = 1800.0

# Most recent dispatches kept. Enough to cover a session's worth of asking,
# small enough that an idle gateway is not holding a transcript.
MAX_TRACKED = 50

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class ComsSendError(Exception):
    """The prompt could not be handed over. Carries a human-readable reason."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ulid() -> str:
    """Port of ulid() in coms-envelope.ts — 10 chars of time, 16 of randomness."""
    ms = int(time.time() * 1000)
    time_part = ""
    for _ in range(10):
        time_part = _CROCKFORD[ms % 32] + time_part
        ms //= 32
    rand_part = "".join(secrets.choice(_CROCKFORD) for _ in range(16))
    return (time_part + rand_part)[:26]


def validate_project(project: str) -> str:
    if not isinstance(project, str) or ".." in project or "/" in project or "\\" in project:
        raise ComsSendError(f"invalid project name: {project!r}")
    if project in (".", "") or not _PROJECT_SAFE.match(project):
        raise ComsSendError(f"invalid project name: {project!r}")
    return project


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not _NAME_SAFE.match(name) or name == "projects":
        raise ComsSendError(f"invalid coms name: {name!r}")
    return name


def resolve_endpoint(project: str, name: str, root: Path | None = None) -> str:
    """The peer's socket path — the only place this value is produced.

    Re-reads the registry rather than trusting anything the caller passed: the
    panel's snapshot is up to 3 seconds old, and a peer that died in that window
    must fail here instead of having a prompt written into a stale path.
    """
    root = Path(root) if root is not None else coms_registry.default_projects_root()
    path = root / project / "agents" / f"{name}.json"
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ComsSendError(f"no live peer {name!r} in project {project!r}") from error
    except (OSError, ValueError) as error:
        raise ComsSendError(f"cannot read the registry entry for {name!r}: {error}") from error

    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    if not coms_registry.entry_is_live(entry, now_ms):
        raise ComsSendError(f"peer {name!r} in project {project!r} is no longer live")

    endpoint = entry.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise ComsSendError(f"peer {name!r} has no endpoint to write to")
    return endpoint


def _read_line(sock: socket.socket, cap: int = 65_536) -> str:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if b"\n" in chunk or total > cap:
            break
    return b"".join(chunks).split(b"\n", 1)[0].decode("utf-8", "replace")


def send_envelope(endpoint: str, envelope: dict, timeout: float = 5.0) -> dict:
    """Write one envelope, read one ack/nack. Mirrors sendEnvelope()."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        try:
            sock.connect(endpoint)
        except OSError as error:
            raise ComsSendError(f"peer is not listening: {error}") from error
        sock.sendall((json.dumps(envelope) + "\n").encode("utf-8"))
        line = _read_line(sock)
    except socket.timeout as error:
        raise ComsSendError("peer did not acknowledge in time") from error
    finally:
        try:
            sock.close()
        except OSError:
            pass

    try:
        parsed = json.loads(line)
    except ValueError as error:
        raise ComsSendError("peer answered with something that is not an envelope") from error
    if isinstance(parsed, dict) and parsed.get("type") == "nack":
        raise ComsSendError(str(parsed.get("error") or "peer refused the prompt"))
    return parsed if isinstance(parsed, dict) else {}


class Dispatcher:
    """Sends prompts and holds the answers that come back.

    One reply socket per dispatch, closed as soon as its answer lands (or when
    REPLY_TTL_S expires). A single shared socket would be tidier until two
    prompts are outstanding and the answers have to be told apart by msg_id
    alone — which is exactly when it matters that they cannot be confused.
    """

    def __init__(self, sockets_dir: Path | None = None, ttl_s: float = REPLY_TTL_S):
        self._dir = Path(sockets_dir) if sockets_dir is not None else Path.home() / ".pi" / "coms" / "sockets"
        self._ttl_s = ttl_s
        self._lock = threading.Lock()
        self._tracked: dict[str, dict] = {}

    # ── the answer side ────────────────────────────────────────────────────

    def _record(self, msg_id: str, **fields) -> None:
        with self._lock:
            entry = self._tracked.get(msg_id)
            if entry is None:
                return
            entry.update(fields)

    def _serve_reply(self, server: socket.socket, path: Path, msg_id: str) -> None:
        """Accept at most one response for `msg_id`, then take the socket down."""
        try:
            server.settimeout(self._ttl_s)
            while True:
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    self._record(msg_id, status="timeout", detail=f"no answer within {int(self._ttl_s)}s")
                    return
                except OSError:
                    return
                with conn:
                    conn.settimeout(5.0)
                    try:
                        line = _read_line(conn)
                        envelope = json.loads(line)
                    except (OSError, ValueError):
                        continue
                    if not isinstance(envelope, dict):
                        continue
                    kind = envelope.get("type")
                    # Peers ping an endpoint to check it is alive; that is not
                    # an answer and must not close the socket.
                    if kind == "ping":
                        self._ack(conn, envelope.get("msg_id") or "")
                        continue
                    if kind != "response" or envelope.get("msg_id") != msg_id:
                        continue
                    self._ack(conn, msg_id)
                    error = envelope.get("error")
                    self._record(
                        msg_id,
                        status="error" if error else "answered",
                        detail=str(error) if error else None,
                        response=_as_text(envelope.get("response")),
                        answered_at=now_iso(),
                    )
                    return
        finally:
            try:
                server.close()
            except OSError:
                pass
            try:
                path.unlink()
            except OSError:
                pass

    @staticmethod
    def _ack(conn: socket.socket, msg_id: str) -> None:
        try:
            conn.sendall((json.dumps({"type": "ack", "msg_id": msg_id}) + "\n").encode("utf-8"))
        except OSError:
            pass

    def _open_reply_socket(self, session_id: str) -> tuple[socket.socket, Path]:
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._dir / f"{session_id}.sock"
        try:
            path.unlink()
        except OSError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(4)
        return server, path

    # ── the ask side ───────────────────────────────────────────────────────

    def dispatch(self, project: str, name: str, prompt: str, root: Path | None = None) -> dict:
        project = validate_project(project)
        name = validate_name(name)
        if not isinstance(prompt, str) or not prompt.strip():
            raise ComsSendError("a prompt is required")
        if len(prompt) > MAX_PROMPT_CHARS:
            raise ComsSendError(f"prompt is longer than {MAX_PROMPT_CHARS} characters")

        endpoint = resolve_endpoint(project, name, root)
        session_id = ulid()
        server, reply_path = self._open_reply_socket(session_id)
        envelope = {
            "type": "prompt",
            "msg_id": ulid(),
            "sender_session": session_id,
            "sender_endpoint": str(reply_path),
            "hops": 0,
            "timestamp": now_iso(),
            "prompt": prompt,
            "sender_name": SENDER_NAME,
            "sender_cwd": os.getcwd(),
            "conversation_id": None,
            "response_schema": None,
        }
        msg_id = envelope["msg_id"]

        with self._lock:
            self._tracked[msg_id] = {
                "msg_id": msg_id,
                "project": project,
                "name": name,
                "prompt": prompt,
                "sent_at": now_iso(),
                "status": "pending",
                "detail": None,
                "response": None,
                "answered_at": None,
            }
            # Oldest first; `dict` preserves insertion order.
            while len(self._tracked) > MAX_TRACKED:
                self._tracked.pop(next(iter(self._tracked)))

        # The listener must be up before the prompt goes out: a fast peer can
        # answer before a thread that is started afterwards ever accepts.
        threading.Thread(
            target=self._serve_reply,
            args=(server, reply_path, msg_id),
            name=f"coms-reply-{msg_id[:8]}",
            daemon=True,
        ).start()

        try:
            send_envelope(endpoint, envelope)
        except ComsSendError:
            self._record(msg_id, status="failed")
            try:
                server.close()
            except OSError:
                pass
            raise

        with self._lock:
            return dict(self._tracked[msg_id])

    def recent(self, limit: int = 20) -> list[dict]:
        """Newest first, prompts trimmed — this feeds a 300px-wide pane."""
        with self._lock:
            rows = list(self._tracked.values())[-limit:]
        rows.reverse()
        return [
            {
                **row,
                "prompt": _clip(row["prompt"], 200),
                "response": _clip(row["response"], 2000) if row["response"] else None,
            }
            for row in rows
        ]


def _as_text(response) -> str | None:
    if response is None:
        return None
    if isinstance(response, str):
        return response
    try:
        return json.dumps(response, indent=2)
    except (TypeError, ValueError):
        return str(response)


def _clip(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"
