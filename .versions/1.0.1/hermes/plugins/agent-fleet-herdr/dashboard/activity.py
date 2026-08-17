"""Source C — what a session is doing RIGHT NOW, from its own transcript.

The registry says a session exists; herdr says whether a pane looks busy. Neither
can say what the busy-ness IS. pi already writes every message it sends and
receives to `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`, whether or not
anybody is watching — which is why this source works for a `detached` session
that no pane hosts at all.

Three rules hold this module up.

**The mapping is authoritative through `boot`, never through the slug.** The
slug (`/home/x/repo` -> `--home-x-repo--`) only narrows the search; the match is
`coms-log/boot.session_id == registry.session_id`. A cwd routinely holds a dozen
transcripts — every resumed session, every restart, and a pi and a Claude Code
pane can share it exactly — so a slug-only rule would pick a stranger's file and
report its work as this agent's. Picking the wrong transcript is the failure
mode this whole module is shaped to avoid: it is not "no data", it is confident
fiction.

**Bounded reads only.** A long session's transcript is megabytes and it is being
appended to while we read it. The tail is capped, the head scan that finds `boot`
is capped, the candidate list is capped, and every parse is cached on
`(path, size, mtime)` so a 3s poll of an idle agent costs one `stat`.

**Projection, not forwarding.** A transcript holds everything the agent has ever
read — file contents, tool output, whatever the user pasted. Nothing is
forwarded wholesale. Each step becomes `{seq, at, kind, label, detail}` and a
tool's arguments pass a PER-TOOL allowlist: `bash` yields its command, `read`
yields a path, `dispatch_agent` yields the target agent. A tool nobody listed
yields its name and nothing else, which is the safe direction to be wrong in.

`seq` is the byte offset of the end of the line a step came from. It is monotone
within a file, survives the file growing under us, and needs no state on either
side — the cursor IS the position in the transcript.
"""

import json
import re
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

# The tail we are willing to read for steps. ~256 KB is several hundred messages
# — far more than a pane shows — and a hard ceiling on what a poll costs.
TAIL_BYTES = 256 * 1024

# The head we are willing to read looking for `boot`. It is written within the
# first few lines, but a session that opens with a large pasted prompt can push
# it down; past this we give up on the file rather than read all of it.
HEAD_BYTES = 256 * 1024

# Newest-first, by mtime. A cwd with more transcripts than this has older ones
# that cannot belong to a session the registry currently calls live.
MAX_CANDIDATES = 24

# Per step. Long enough for a git command to still be recognisable, short enough
# that a step is one line in a 300px pane.
DETAIL_CHARS = 140

DEFAULT_LIMIT = 50
MAX_LIMIT = 200

# Parsed tails and boot records, keyed so a changed file misses. Bounded because
# a gateway runs for days and every project the human touches lands here.
CACHE_ENTRIES = 32

# What each tool is allowed to say about itself. The KEY is the tool name and
# the VALUE is the ordered list of argument names that may be shown — everything
# else in the call is dropped. A tool that is not in this map is rendered by name
# alone: new tools appear all the time and the default must not be "spill it".
_TOOL_DETAIL = {
    "bash": ("command",),
    "read": ("path",),
    "write": ("path",),
    "edit": ("path",),
    "ls": ("path",),
    "glob": ("pattern",),
    "grep": ("pattern",),
    "find": ("pattern", "glob"),
    "dispatch_agent": ("agent",),
    "spawn_research": ("persona",),
    "coms_send": ("target",),
    "coms_await": ("target",),
    "coms_list": (),
    "herdr_read_pane": ("pane_id",),
    "herdr_spawn_peer": ("name",),
    "herdr_close_pane": ("pane_id",),
    "ask_user": ("question",),
    "set_task_tier": ("tier",),
    "request_compaction": ("reason",),
}

# Tools whose whole point is that work left this agent — worth their own kind so
# a human reading the timeline can see the fan-out.
_DISPATCH_TOOLS = {"dispatch_agent", "spawn_research", "coms_send", "coms_await", "herdr_spawn_peer"}

# Tools that stop and wait for a human. The row's `blocked` state comes from
# herdr; this is the same fact from the other side, with the question attached.
_BLOCKED_TOOLS = {"ask_user"}

KIND_TOOL = "tool"
KIND_ASSISTANT = "assistant"
KIND_DISPATCH = "dispatch"
KIND_BLOCKED = "blocked"
KIND_DONE = "done"

# coms-log records worth a step, and the ONE field of each that may be shown.
# `inbound_prompt` carries a `sender` session id and `outbound_response` an
# error object; neither is offered, for the same reason `session_id` never
# leaves sessions.py.
_COMS_EVENT = {
    "inbound_prompt": (KIND_DISPATCH, "prompt received", None),
    "outbound_prompt": (KIND_DISPATCH, "prompt sent", "target"),
    "outbound_response": (KIND_DISPATCH, "answered a peer", None),
    "outbound_response_failed": (KIND_DISPATCH, "could not answer a peer", "reason"),
    "shutdown": (KIND_DONE, "session shut down", None),
}

# What a turn ending is called. `toolUse` / `tool_use` is not here on purpose:
# it means the turn is CONTINUING, and announcing it as an end would make every
# working agent read as finished.
_STOP_LABEL = {
    "stop": "finished the turn",
    "error": "the turn failed",
    "aborted": "the turn was aborted",
    # Claude Code's dialect of the same field.
    "end_turn": "finished the turn",
    "max_tokens": "the turn ran out of room",
    "refusal": "the turn was refused",
}

# ── the Claude Code dialect ────────────────────────────────────────────────
#
# A bridged Claude Code peer writes an ENTIRELY different file: the Anthropic
# message shape, `tool_use` instead of `toolCall`, `input` instead of
# `arguments`, PascalCase tool names, and the record type at the top level
# rather than under `type: "message"`. Two dialects, one projection — the panel
# must not care which agent it is watching.
_CLAUDE_TOOL_DETAIL = {
    "Bash": ("command",),
    "Read": ("file_path",),
    "Write": ("file_path",),
    "Edit": ("file_path",),
    "NotebookEdit": ("notebook_path",),
    "Glob": ("pattern",),
    "Grep": ("pattern",),
    "Task": ("subagent_type", "description"),
    "Agent": ("subagent_type", "description"),
    "SendMessage": ("agent_id",),
    "WebFetch": ("url",),
    "WebSearch": ("query",),
    "Skill": ("skill",),
    "AskUserQuestion": (),
    "TodoWrite": (),
}

_CLAUDE_DISPATCH_TOOLS = {"Task", "Agent", "SendMessage"}
_CLAUDE_BLOCKED_TOOLS = {"AskUserQuestion", "ExitPlanMode"}

# Where the Stop hook leaves the only authoritative link between a coms peer and
# a Claude Code transcript. See `claude_transcript`.
BRIDGE_HOOK_BASENAME = "last-message.json"

# A Claude Code session id, strictly. It is interpolated into a path, so it may
# contain nothing that could climb out of one.
_CLAUDE_SESSION_RE = re.compile(r"^[0-9a-fA-F][0-9a-fA-F-]{7,63}$")

# What the bridge does to a herdr pane id before using it as a directory name
# (`hookWatchDir` in scripts/coms-claude-bridge.ts). Copied rather than derived:
# it has to agree character for character with the writer.
_PANE_DIR_SAFE = re.compile(r"[^A-Za-z0-9_-]")

# The registry `model` a bridged Claude Code peer registers with
# (coms-claude-bridge.ts). It is the discriminator for which reader to use, and
# it is why a pi peer never pays for the herdr lookup this one needs.
CLAUDE_MODEL = "claude-code"


def sessions_root() -> Path:
    return Path.home() / ".pi" / "agent" / "sessions"


def slug_for_cwd(cwd: str) -> str:
    """`/home/x/repo` -> `--home-x-repo--`.

    A port of the one line pi encodes with (`migrations.js:101`):
    strip the leading separator, then `/`, `\\` and `:` all become `-`, wrapped
    in a leading and trailing `--`. Every other character — dots included —
    survives, which is why `agent-fleet.hermes-plugin` keeps its dot.
    """
    if not isinstance(cwd, str) or not cwd:
        return ""
    trimmed = cwd.lstrip("/\\")
    flattened = trimmed.replace("/", "-").replace("\\", "-").replace(":", "-")
    return f"--{flattened}--"


def candidate_paths(cwd: str, root: Path | None = None) -> list[Path]:
    """Transcripts for this cwd, newest first. Never raises.

    Newest first because the match usually lands on the first file, and the scan
    stops as soon as `boot` agrees — so the common case reads one head.
    """
    slug = slug_for_cwd(cwd)
    if not slug:
        return []
    folder = (Path(root) if root is not None else sessions_root()) / slug
    try:
        files = [child for child in folder.iterdir() if child.suffix == ".jsonl" and child.is_file()]
    except OSError:
        return []
    try:
        files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        files.sort(reverse=True)
    return files[:MAX_CANDIDATES]


class _Cache(OrderedDict):
    """Smallest possible LRU. Correctness lives in the key, not in here."""

    def take(self, key):
        value = self.get(key)
        if value is not None:
            self.move_to_end(key)
        return value

    def put(self, key, value):
        self[key] = value
        self.move_to_end(key)
        while len(self) > CACHE_ENTRIES:
            self.popitem(last=False)
        return value


_boot_cache = _Cache()
_tail_cache = _Cache()


def _stat(path: Path):
    try:
        return path.stat()
    except OSError:
        return None


def boot_identity(path: Path) -> dict | None:
    """`{session_id, name, project}` from this transcript's coms-log boot.

    `None` for a transcript with no boot record at all — a pi session that never
    joined coms. That is the normal case for most files in a cwd, so it must be
    cheap and silent, not an error.
    """
    info = _stat(path)
    if info is None:
        return None
    # The record is immutable once written, so the key only has to notice the
    # file being REPLACED — a new inode, or one that shrank.
    key = (str(path), info.st_ino, info.st_size)
    cached = _boot_cache.take(key)
    if cached is not None:
        return cached.get("identity")

    identity = None
    try:
        with open(path, "rb") as handle:
            head = handle.read(HEAD_BYTES)
    except OSError:
        head = b""
    for line in head.split(b"\n")[:-1] or []:
        try:
            record = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("customType") != "coms-log":
            continue
        data = record.get("data")
        if isinstance(data, dict) and data.get("event") == "boot" and data.get("session_id"):
            identity = {
                "session_id": str(data.get("session_id")),
                "name": data.get("name"),
                "project": data.get("project"),
            }
            break
    _boot_cache.put(key, {"identity": identity})
    return identity


def find_transcript(cwd: str, session_id: str, root: Path | None = None) -> Path | None:
    """The transcript belonging to THIS coms session, or None.

    The slug narrows; `boot` decides. A candidate whose boot names a different
    session is skipped rather than used as a fallback — an approximate answer
    here is a confident lie about what another agent is doing.
    """
    if not isinstance(session_id, str) or not session_id:
        return None
    for path in candidate_paths(cwd, root):
        identity = boot_identity(path)
        if identity is not None and identity.get("session_id") == session_id:
            return path
    return None


def claude_projects_root() -> Path:
    return Path.home() / ".claude" / "projects"


def bridge_hook_root() -> Path:
    """Where coms-claude-bridge.ts keeps its per-pane hook directories."""
    return Path.home() / ".pi" / "coms" / "claude-bridge"


def bridge_hook_path(pane_id: str, root: Path | None = None) -> Path | None:
    """`~/.pi/coms/claude-bridge/<pane>/last-message.json` for a herdr pane.

    The pane id is sanitised exactly as `hookWatchDir()` in
    scripts/coms-claude-bridge.ts sanitises it — copied rather than derived,
    because it has to agree with the writer character for character, and because
    that same rule is what keeps a herdr-supplied string out of the filesystem.
    """
    if not isinstance(pane_id, str) or not pane_id:
        return None
    folder = _PANE_DIR_SAFE.sub("_", pane_id)
    if not folder or folder.strip("_") == "":
        return None
    base = Path(root) if root is not None else bridge_hook_root()
    return base / folder / BRIDGE_HOOK_BASENAME


def claude_transcript(pane_id: str, hook_root: Path | None = None, projects_root: Path | None = None) -> Path | None:
    """The Claude Code transcript for a bridged peer, or None.

    This is the whole reason the Stop hook writes `transcript_path`. The bridge
    mints its OWN coms session id (`ulid()` in coms-claude-bridge.ts) and Claude
    Code knows nothing about it, so there is no shared identifier anywhere on
    disk except the one the hook puts there. Without it the only available rule
    would be "newest transcript in this cwd" — and a cwd routinely holds a dozen,
    which is exactly the guess this module refuses to make for pi sessions.

    Two consequences worth stating. A peer whose Stop hook has never fired has
    no link yet, and answers `available: false` rather than a guess. And the
    chain runs through the herdr pane, so a `detached` Claude Code peer cannot be
    matched at all — which is the opposite of the pi case, and honest.
    """
    hook = bridge_hook_path(pane_id, hook_root)
    if hook is None:
        return None
    try:
        record = json.loads(hook.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None

    root = Path(projects_root) if projects_root is not None else claude_projects_root()
    # Preferred: the path Claude Code itself handed the hook. Confined to the
    # transcript root before it is opened — it arrives from a file another
    # process writes, so it is an input, not a fact.
    claimed = record.get("transcript_path")
    if isinstance(claimed, str) and claimed.endswith(".jsonl"):
        candidate = Path(claimed)
        try:
            candidate.relative_to(root)
        except ValueError:
            candidate = None
        if candidate is not None and candidate.is_file():
            return candidate

    # Fallback for a hook that predates `transcript_path`: the session id names
    # the file. Searched rather than slugged — the id is unique across every
    # project, so there is no encoding rule to get wrong.
    session_id = record.get("session_id")
    if not isinstance(session_id, str) or not _CLAUDE_SESSION_RE.match(session_id):
        return None
    try:
        for folder in root.iterdir():
            candidate = folder / f"{session_id}.jsonl"
            if candidate.is_file():
                return candidate
    except OSError:
        return None
    return None


def _steps_from_claude(record: dict, seq: int) -> list[dict]:
    """One line of a Claude Code transcript -> steps.

    Same allowlist discipline as the pi reader, applied to a different shape:
    `tool_use`/`input` rather than `toolCall`/`arguments`, and the record's own
    `timestamp` because the inner message carries none at all.
    """
    if record.get("type") != "assistant":
        return []
    message = record.get("message")
    if not isinstance(message, dict):
        return []

    at = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
    steps: list[dict] = []
    for item in message.get("content") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "tool_use":
            name = item.get("name") or "tool"
            if name in _CLAUDE_BLOCKED_TOOLS:
                kind = KIND_BLOCKED
            elif name in _CLAUDE_DISPATCH_TOOLS:
                kind = KIND_DISPATCH
            else:
                kind = KIND_TOOL
            steps.append(
                _step(seq, at, kind, str(name), tool_detail(name, item.get("input"), _CLAUDE_TOOL_DETAIL))
            )
        elif item.get("type") == "text" and isinstance(item.get("text"), str) and item["text"].strip():
            steps.append(_step(seq, at, KIND_ASSISTANT, "said", _clip(item["text"])))

    stop = message.get("stop_reason")
    if stop in _STOP_LABEL:
        steps.append(_step(seq, at, KIND_DONE, _STOP_LABEL[stop]))
    return steps


def read_tail(path: Path, budget: int = TAIL_BYTES) -> list[tuple[int, str]]:
    """The last `budget` bytes as `(end_offset, line)`, whole lines only.

    Both ends are cut on purpose. The FIRST line is dropped whenever the read
    started mid-file, because a byte budget lands in the middle of a JSON object
    and half an object is not a smaller object. The LAST line is dropped unless
    it ended in a newline, because pi is appending to this file as we read it and
    a line without its terminator is a line still being written.
    """
    info = _stat(path)
    if info is None:
        return []
    start = max(0, info.st_size - max(0, budget))
    try:
        with open(path, "rb") as handle:
            handle.seek(start)
            data = handle.read()
    except OSError:
        return []

    offset = start
    if start > 0:
        cut = data.find(b"\n")
        if cut < 0:
            return []
        offset = start + cut + 1
        data = data[cut + 1 :]

    rows: list[tuple[int, str]] = []
    pieces = data.split(b"\n")
    # `split` leaves the bytes after the final newline as the last element: empty
    # when the file ends cleanly, a partial record when it does not. Either way
    # it is not ours to parse.
    for piece in pieces[:-1]:
        offset += len(piece) + 1
        text = piece.decode("utf-8", "replace").strip()
        if text:
            rows.append((offset, text))
    return rows


def _clip(value) -> str:
    """One line, bounded. Newlines become spaces so a step stays a step.

    Only scalars render. A list or a dict where a string was expected is the
    shape changing under us, and `str()` on one of those would paste an entire
    nested structure — the exact thing the allowlist exists to prevent — so it
    renders as nothing instead.
    """
    if isinstance(value, bool) or isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return ""
    collapsed = " ".join(value.split())
    if len(collapsed) <= DETAIL_CHARS:
        return collapsed
    return collapsed[: DETAIL_CHARS - 1] + "…"


def tool_detail(name, arguments, allowlist=None) -> str:
    """The allowlisted part of a tool call, or the empty string.

    An unlisted tool gets nothing — not a truncated dump, not the first
    argument. The allowlist is the security boundary and the default has to fail
    closed, because the argument that is not on the list is exactly the one
    holding a file's contents or somebody's token.

    `allowlist` selects the dialect: pi's tools by default, Claude Code's when
    the caller says so. They are separate maps rather than one merged map so a
    name that exists in both cannot inherit the other one's fields.
    """
    fields = (allowlist if allowlist is not None else _TOOL_DETAIL).get(name if isinstance(name, str) else "")
    if not fields or not isinstance(arguments, dict):
        return ""
    parts = [_clip(arguments.get(field)) for field in fields]
    return _clip(" ".join(part for part in parts if part))


def _when(record: dict, message: dict | None = None) -> str | None:
    """The ISO instant a record was appended, from whichever field carries one.

    There are two timestamps in a pi message envelope and they are neither the
    same clock nor the same encoding: the RECORD's is an ISO string written when
    the line was appended, the MESSAGE's is epoch milliseconds stamped when the
    turn was requested. The record's is both the one we want — "how long ago did
    this happen" — and the one that already parses.
    """
    at = record.get("timestamp")
    if isinstance(at, str) and at:
        return at
    at = (message or {}).get("timestamp")
    if isinstance(at, str) and at:
        return at
    if isinstance(at, (int, float)) and not isinstance(at, bool):
        return (
            datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )
    return None


def _step(seq: int, at, kind: str, label: str, detail: str = "") -> dict:
    return {
        "seq": seq,
        "at": at if isinstance(at, str) else None,
        "kind": kind,
        "label": label,
        "detail": detail,
    }


def _steps_from_message(record: dict, seq: int) -> list[dict]:
    message = record.get("message") if isinstance(record.get("message"), dict) else record
    if message.get("role") != "assistant":
        # Deliberately only the assistant side. `user` content is arbitrary text
        # the human pasted, and a `toolResult` is the OUTPUT of a call whose name
        # the timeline already shows — the two largest ways to leak a transcript
        # into a renderer, for the least gain.
        return []

    at = _when(record, message)
    steps: list[dict] = []
    for item in message.get("content") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "toolCall":
            name = item.get("name") or "tool"
            if name in _BLOCKED_TOOLS:
                kind = KIND_BLOCKED
            elif name in _DISPATCH_TOOLS:
                kind = KIND_DISPATCH
            else:
                kind = KIND_TOOL
            steps.append(_step(seq, at, kind, str(name), tool_detail(name, item.get("arguments"))))
        elif item.get("type") == "text" and isinstance(item.get("text"), str) and item["text"].strip():
            steps.append(_step(seq, at, KIND_ASSISTANT, "said", _clip(item["text"])))
        # `thinking` is skipped: it is the largest block in the file and the one
        # the model was told nobody would read.

    stop = message.get("stopReason")
    if stop in _STOP_LABEL:
        steps.append(_step(seq, at, KIND_DONE, _STOP_LABEL[stop]))
    return steps


def _steps_from_custom(record: dict, seq: int) -> list[dict]:
    if record.get("customType") != "coms-log":
        return []
    data = record.get("data")
    if not isinstance(data, dict):
        return []
    mapped = _COMS_EVENT.get(data.get("event"))
    if mapped is None:
        return []
    kind, label, field = mapped
    return [_step(seq, _when(record), kind, label, _clip(data.get(field)) if field else "")]


def project_steps(rows: list[tuple[int, str]]) -> list[dict]:
    """`(offset, line)` pairs -> the timeline, oldest first.

    A line that will not parse is skipped without comment: at the head of a tail
    it is a record we cut in half, and anywhere else it is one pi was still
    writing. Neither is worth an error in a panel.
    """
    steps: list[dict] = []
    for seq, text in rows:
        try:
            record = json.loads(text)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        kind = record.get("type")
        if kind == "message":
            steps.extend(_steps_from_message(record, seq))
        elif kind == "custom":
            steps.extend(_steps_from_custom(record, seq))
        elif kind == "assistant":
            # The Claude Code dialect puts the role at the top level. The two
            # never collide: pi writes `type: "message"` and nothing else.
            steps.extend(_steps_from_claude(record, seq))
    return steps


def steps_for_path(path: Path) -> list[dict]:
    """The parsed tail, cached on `(path, size, mtime)`.

    An idle agent's transcript does not change, and the pane polls it every 3
    seconds; without this the panel would re-parse a quarter of a megabyte to
    render the same list.
    """
    info = _stat(path)
    if info is None:
        return []
    key = (str(path), info.st_size, info.st_mtime_ns)
    cached = _tail_cache.take(key)
    if cached is not None:
        return cached["steps"]
    steps = project_steps(read_tail(path))
    _tail_cache.put(key, {"steps": steps})
    return steps


def _age_s(value, now_ms: float) -> int | None:
    parsed = None
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, int((now_ms - parsed.timestamp() * 1000) / 1000))


def unavailable(reason: str) -> dict:
    """The honest answer, which is a 200. There is no error shape here.

    A session with no transcript is the ordinary case — a Claude Code peer, a
    session started before pi wrote sessions, a cwd that moved — and a panel that
    turned that into a red box would be crying wolf several times a minute.
    """
    return {"available": False, "reason": reason, "steps": [], "current": None, "seq": 0}


def transcript_for_entry(entry: dict, pane_id=None, root: Path | None = None) -> tuple[Path | None, str]:
    """The file to read for this peer, and — when there is none — why not.

    Two agents, two dialects, two entirely different ways of being found. A pi
    peer is matched through the `boot` record inside its own transcript, which
    works whether or not anything is watching it. A bridged Claude Code peer has
    no such record — the bridge invents its coms session id and Claude Code has
    never heard of it — so the link runs through the herdr pane and the Stop
    hook, and it exists only once that hook has fired.
    """
    if entry.get("model") == CLAUDE_MODEL:
        if not pane_id:
            return None, "no herdr pane hosts this bridged peer, so its transcript cannot be identified"
        path = claude_transcript(str(pane_id))
        if path is None:
            return None, "no Claude Code transcript is linked yet — the Stop hook writes the link on its first turn"
        return path, ""

    session_id = entry.get("session_id")
    cwd = entry.get("cwd")
    if not session_id or not cwd:
        return None, "this session predates the transcript link"
    path = find_transcript(str(cwd), str(session_id), root)
    if path is None:
        return None, "no pi transcript matches this session"
    return path, ""


def activity_for_entry(
    entry: dict,
    after: int = 0,
    limit: int = DEFAULT_LIMIT,
    root: Path | None = None,
    now_ms: float | None = None,
    pane_id=None,
) -> dict:
    """`{available, steps, current, seq}` for one registry entry.

    `after` is a byte offset into the transcript, handed back as `seq`. Steps
    from the same line share one `seq` and are therefore taken or skipped
    together, which is why the limit is applied in whole lines: a cursor that
    landed inside a line would silently drop the other tool calls in it.
    """
    path, reason = transcript_for_entry(entry, pane_id=pane_id, root=root)
    if path is None:
        return unavailable(reason)

    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    steps = steps_for_path(path)
    # Computed before the cursor is applied: "what is it doing" is the last thing
    # in the file, not the last thing this particular client has not seen yet.
    last = steps[-1] if steps else None
    current = None
    if last is not None:
        current = {
            "kind": last["kind"],
            "label": last["label"],
            "detail": last["detail"],
            "at": last["at"],
            "since_s": _age_s(last["at"], now_ms),
        }

    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    fresh = [step for step in steps if step["seq"] > max(0, after)]
    if len(fresh) > limit:
        # Trimmed from the FRONT — the newest steps are the ones being asked
        # about. A cut landing inside a line (an assistant turn with three tool
        # calls shares one `seq`) is widened BACKWARDS to take the whole line:
        # the next cursor is a byte offset, so a line returned in part could
        # never be completed, and overshooting a soft budget by two steps is
        # cheaper than losing them.
        cut = len(fresh) - limit
        boundary = fresh[cut]["seq"]
        while cut > 0 and fresh[cut - 1]["seq"] == boundary:
            cut -= 1
        fresh = fresh[cut:]

    return {
        "available": True,
        "reason": "",
        "steps": fresh,
        "current": current,
        # The end of the file, not the end of what we returned: a client that
        # asked for 50 steps out of 200 must not spend three round trips
        # crawling forward through history it will never render.
        "seq": steps[-1]["seq"] if steps else max(0, after),
    }


def find_entry(projects: dict[str, list[dict]], project: str, name: str) -> dict | None:
    for entry in projects.get(project) or []:
        if entry.get("name") == name:
            return entry
    return None


def _main(argv: list[str]) -> int:
    """`python3 activity.py <project> <name>` — what the panel would be shown.

    The same question the pane asks, without a Desktop window: it is the fastest
    way to tell "no transcript" from "the wrong transcript".
    """
    import coms_registry

    if len(argv) != 2:
        print("usage: activity.py <project> <name>")
        return 2
    project, name = argv
    entry = find_entry(coms_registry.live_sessions_by_project(), project, name)
    if entry is None:
        print(json.dumps(unavailable(f"no live session {name!r} in project {project!r}"), indent=2))
        return 1
    print(json.dumps(activity_for_entry(entry), indent=2))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv[1:]))
