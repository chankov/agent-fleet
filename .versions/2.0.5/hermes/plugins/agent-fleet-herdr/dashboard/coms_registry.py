"""Source A — which Agent Fleet sessions exist, and in which project.

Reads `~/.pi/coms/projects/<project>/agents/<name>.json` directly. The
directory IS the project: that is exactly the scope `team-up --project X`
creates, so grouping by it needs no extra bookkeeping.

Deliberately NOT going through `coms-cli list`: that CLI wants `--project` and
`--name`, answers for one project only, and excludes the caller — the opposite
of "every project". The price is a dependency on someone else's on-disk shape;
`SUPPORTED_VERSION` below is the tripwire for when it changes.

Read-only by construction. `pruneDeadEntries()` in scripts/lib/coms-envelope.ts
deletes dead records; we copy only its liveness CRITERION. A visualisation
plugin that races the real coms writer over file deletion is the wrong shape.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

# Mirrors REGISTRY_HEARTBEAT_FRESH_MS in scripts/lib/coms-envelope.ts:25, and
# the -5s clock-skew tolerance of registryHeartbeatIsFresh().
HEARTBEAT_FRESH_MS = 90_000
HEARTBEAT_SKEW_MS = 5_000

# `version` in the registry record. A record from a coms that bumped the schema
# is reported as unavailable rather than silently mis-parsed — a wrong panel is
# worse than an honest one that says it cannot read the registry.
SUPPORTED_VERSION = 1


class RegistryUnavailable(Exception):
    """The coms registry cannot be read or is written in a schema we don't know."""


def default_projects_root() -> Path:
    return Path.home() / ".pi" / "coms" / "projects"


def parse_timestamp_ms(value) -> float | None:
    """ISO-8601 (the `Z` form coms writes) to epoch milliseconds."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def heartbeat_is_fresh(entry: dict, now_ms: float) -> bool:
    heartbeat = parse_timestamp_ms(entry.get("heartbeat_at"))
    if heartbeat is None:
        return False
    age = now_ms - heartbeat
    return -HEARTBEAT_SKEW_MS <= age <= HEARTBEAT_FRESH_MS


def pid_is_alive(pid) -> bool:
    """`kill(pid, 0)`: ESRCH means gone, EPERM means alive but not ours."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def entry_is_live(entry: dict, now_ms: float, pid_probe=pid_is_alive) -> bool:
    """A fresh heartbeat wins before the PID probe — Codex remote commands can
    run in a different PID namespace, where the probe would answer nonsense."""
    if heartbeat_is_fresh(entry, now_ms):
        return True
    return pid_probe(entry.get("pid"))


def _read_entry(path: Path) -> dict | None:
    """One registry file, or None when it is not a usable record.

    Unparseable or half-written files are skipped, not fatal: the writer is
    another live process and we may catch it mid-write.
    """
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"]:
        return None
    version = entry.get("version", SUPPORTED_VERSION)
    if version != SUPPORTED_VERSION:
        raise RegistryUnavailable(
            f"coms registry record {path.name} declares schema version {version!r}, "
            f"this plugin reads version {SUPPORTED_VERSION}"
        )
    return entry


def live_sessions_by_project(root: Path | None = None, now_ms: float | None = None, pid_probe=pid_is_alive) -> dict[str, list[dict]]:
    """Every live coms session, keyed by project directory name.

    Projects with no live session are omitted entirely: `~/.pi/coms/projects/`
    accumulates dozens of historical scopes, and an empty group is noise.
    """
    root = Path(root) if root is not None else default_projects_root()
    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000

    try:
        project_dirs = sorted(child for child in root.iterdir() if child.is_dir())
    except OSError as error:
        raise RegistryUnavailable(f"cannot read coms registry at {root}: {error}") from error

    projects: dict[str, list[dict]] = {}
    for project_dir in project_dirs:
        agents_dir = project_dir / "agents"
        try:
            files = sorted(agents_dir.glob("*.json"))
        except OSError:
            continue
        live = []
        for path in files:
            entry = _read_entry(path)
            if entry is not None and entry_is_live(entry, now_ms, pid_probe):
                live.append(entry)
        if live:
            projects[project_dir.name] = live
    return projects
