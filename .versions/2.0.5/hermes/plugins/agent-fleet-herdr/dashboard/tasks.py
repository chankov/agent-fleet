"""Source D — the subagents a hub is running, from the agent-fleet-monitor.

This is the half Phase 3's activity tail cannot reach. A transcript says what
the hub itself did; it says nothing about the child processes the hub spawned,
carries no way to stop one, and has no raw stdout. The monitor has all three and
was simply never started (no launcher exported its two variables) and never
joined to anything a human was already looking at.

The join, and why it is exact
-----------------------------
A monitor CHILD task records `hubPaneId` — literally `env.HERDR_PANE_ID` of the
hub that spawned it (hermes-monitor-herdr.correlateHubPane). The herdr pane
snapshot this panel already takes for every session records `pane_id`. So a
session owns a task when its pane id equals the task's `hubPaneId`: one
identifier, written by one process, read on both sides. No cwd guessing, no
"newest hub wins" — the same rule Phase 3 refused to relax.

The consequence is stated rather than hidden: the correlation runs THROUGH the
pane, so a `detached` hub has no task tree here, exactly as a detached Claude
Code peer has no activity tail. Parent tasks carry no pane id at all, so they
are reached only via a child's `parentId`.

Why the monitor's own adapter is imported instead of copied
-----------------------------------------------------------
`adapter.py` is ~60 lines of security-critical discovery: 0700 root, 0600
discovery and token files, a recomputed socket hash the discovery file must
agree with, lease expiry, and the unlink of what has expired. A second copy in
this plugin would be a second thing to get wrong. Both plugins ship from the
same checkout and install as siblings under `<hermes home>/plugins/`, so the
sibling path resolves in either shape. When it does not resolve — the monitor
plugin was archived, or only this one was installed — that is `available:
False` with a reason, never an exception.
"""

import importlib.util
import sys
from pathlib import Path

# Everything a task is allowed to tell the renderer. `ownerSessionId` and
# `ownerLeaseExpiresAt` are the monitor's own lease bookkeeping, `checkoutId`
# and `workspaceId` are correlation the panel already knows by other means:
# none of them belong in a file that runs with the full privileges of the app.
# `hubInstanceId` DOES travel, because cancel has to be addressed to one hub and
# it is a sha256 digest rather than a path.
_TASK_FIELDS = (
    "id",
    "generation",
    "kind",
    "state",
    "specialist",
    "parentId",
    "parentGeneration",
    "hubInstanceId",
    "updatedAt",
    "outputSequence",
)

# Per-task stdout carried inline. The monitor stores up to 256 KB per task and
# serves it behind a cursor; this panel is a viewer, not an archive, so it takes
# a bounded tail with no cursor at all. That trade removes an entire per-task
# cursor protocol from the herdr side, and what it costs is history the monitor
# pane still has if anyone needs it.
MAX_OUTPUT_CHARS = 2048

# How many tasks get an output read on one request. Each is its own round trip
# over the hub's UDS, and a runaway hub with fifty children must not turn one
# modal poll into fifty socket connections.
MAX_OUTPUT_READS = 8

# Live states, in the monitor's vocabulary (hermes-monitor-model.ts). Only these
# can be cancelled, and only these are worth spending an output read on.
ACTIVE_STATES = ("starting", "running", "cancelling", "recovering")


class MonitorMissing(Exception):
    """The monitor plugin is not installed beside this one."""


def _load_adapter():
    """Import the monitor plugin's adapter from the sibling plugin directory.

    `__file__` is resolved first, so an installed tree that reaches this file
    through a symlink into a checkout finds the sibling in that checkout rather
    than looking for it under the Hermes profile.
    """
    here = Path(__file__).resolve()
    candidate = here.parent.parent.parent / "agent-fleet-monitor" / "dashboard" / "adapter.py"
    if not candidate.is_file():
        raise MonitorMissing(f"no monitor adapter at {candidate}")
    # Loaded under its own module name and cached, because `adapter` is a name
    # this plugin does not otherwise own and re-importing per request would
    # re-read the file on every poll.
    cached = sys.modules.get("_agent_fleet_monitor_adapter")
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location("_agent_fleet_monitor_adapter", candidate)
    if spec is None or spec.loader is None:
        raise MonitorMissing(f"{candidate} is not importable")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_agent_fleet_monitor_adapter"] = module
    spec.loader.exec_module(module)

    return module


def unavailable(reason: str) -> dict:
    """The shape every failure takes. Never an exception past this module.

    A fleet with no monitor is the ORDINARY case — the variables are opt-in and
    a plain `just fleet` hub has no subagents to report — so the panel says so
    in a sentence and shows the rest of the session.
    """
    return {"available": False, "reason": reason, "tasks": []}


def adapter(env: dict[str, str] | None = None):
    """The live monitor, or `MonitorMissing`/`MonitorUnavailable`."""
    module = _load_adapter()

    return module.MonitorAdapter.from_profile_environment(env)


def _truncate(text) -> str:
    if not isinstance(text, str) or not text:
        return ""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    # The tail, not the head: what a subagent is doing now is at the end.
    return text[-MAX_OUTPUT_CHARS:]


def project_task(task: dict) -> dict:
    """One monitor task through the allowlist."""
    row = {field: task[field] for field in _TASK_FIELDS if field in task and task[field] is not None}
    if task.get("truncated"):
        row["truncated"] = True

    return row


def build_tree(tasks: list[dict], pane_id: str) -> list[dict]:
    """The task forest belonging to one hub pane, parents first.

    Children are matched on `hubPaneId`; a parent joins because one of its
    children named it. A child whose parent is not in the snapshot (pruned by
    retention while the child still runs) is kept as its own root rather than
    dropped — an orphan that is still running is exactly what somebody opening
    this panel needs to see.
    """
    if not pane_id:
        return []

    mine = [t for t in tasks if isinstance(t, dict) and t.get("hubPaneId") == pane_id]
    # `hubInstanceId` is part of the key, not just the id and generation: the
    # snapshot merges every hub registered under the profile (FleetMonitorAdapter),
    # and two hubs are perfectly free to number their turns the same way. Without
    # it, a colliding turn id would hang one hub's specialists under another
    # hub's parent — the exact class of wrong-row error this panel refuses.
    wanted_parents = {(t.get("hubInstanceId"), t.get("parentId"), t.get("parentGeneration")) for t in mine}
    parents = [
        t
        for t in tasks
        if isinstance(t, dict)
        and t.get("kind") == "parent"
        and (t.get("hubInstanceId"), t.get("id"), t.get("generation")) in wanted_parents
    ]

    by_parent: dict[tuple, list[dict]] = {}
    for child in mine:
        by_parent.setdefault(
            (child.get("hubInstanceId"), child.get("parentId"), child.get("parentGeneration")), []
        ).append(child)

    roots: list[dict] = []
    claimed: set[tuple] = set()
    for parent in parents:
        key = (parent.get("hubInstanceId"), parent.get("id"), parent.get("generation"))
        claimed.add(key)
        row = project_task(parent)
        row["children"] = [project_task(c) for c in by_parent.get(key, [])]
        roots.append(row)

    for key, children in by_parent.items():
        if key in claimed:
            continue
        for child in children:
            row = project_task(child)
            row["children"] = []
            # Said out loud rather than silently reparented: the hierarchy is
            # missing a level and the reader should know which one.
            row["orphaned_parent"] = True
            roots.append(row)

    return roots


def attach_output(monitor, roots: list[dict]) -> list[dict]:
    """Fill in each live task's stdout tail, best effort, bounded.

    A read that fails leaves the task without output rather than failing the
    request: a child that finished between the snapshot and this call is normal,
    and the tree is still the answer.
    """
    reads = 0
    for row in roots:
        for task in [row, *row.get("children", [])]:
            if reads >= MAX_OUTPUT_READS:
                return roots
            if task.get("state") not in ACTIVE_STATES or not task.get("outputSequence"):
                continue
            reads += 1
            try:
                result = monitor.output(task["id"], task["generation"], 0, task.get("hubInstanceId"))
            except Exception:
                continue
            text = _truncate(result.get("text") if isinstance(result, dict) else "")
            if text:
                task["output"] = text
                if isinstance(result, dict) and result.get("truncated"):
                    task["truncated"] = True

    return roots


def tasks_for_pane(pane_id, env: dict[str, str] | None = None, monitor=None) -> dict:
    """`{available, reason, tasks}` for the hub occupying `pane_id`."""
    if not pane_id:
        return unavailable("no herdr pane is hosting this agent — the monitor correlates through the pane")

    module = None
    if monitor is None:
        try:
            module = _load_adapter()
            monitor = module.MonitorAdapter.from_profile_environment(env)
        except MonitorMissing as error:
            return unavailable(str(error))
        except Exception:
            # MonitorUnavailable and anything else discovery can raise: no hub
            # registered under this profile, an expired lease, a runtime dir
            # that is not 0700. All one answer to a reader.
            return unavailable("no monitored hub is registered for this profile")

    try:
        snapshot = monitor.snapshot()
    except Exception:
        return unavailable("the monitor is not answering")

    tasks = snapshot.get("tasks") if isinstance(snapshot, dict) else None
    if not isinstance(tasks, list):
        return unavailable("the monitor returned no task list")

    roots = build_tree(tasks, pane_id)
    if not roots:
        return {"available": True, "reason": "", "tasks": []}

    return {"available": True, "reason": "", "tasks": attach_output(monitor, roots)}


def cancel_task(pane_id, task_id, generation, hub_instance_id=None, env: dict[str, str] | None = None, monitor=None) -> dict:
    """Cancel one generation of one task — after proving the caller owns it.

    The renderer names a task id it read from `tasks_for_pane`, but a renderer
    is not a trusted source, so the id is looked up in a FRESH snapshot scoped
    to this pane before it reaches the socket. Without that check the route
    would cancel any task in any hub on the machine for anyone who could guess
    an id.
    """
    if monitor is None:
        try:
            module = _load_adapter()
            monitor = module.MonitorAdapter.from_profile_environment(env)
        except MonitorMissing as error:
            raise LookupError(str(error)) from error
        except Exception as error:
            raise LookupError("no monitored hub is registered for this profile") from error

    try:
        snapshot = monitor.snapshot()
    except Exception as error:
        raise LookupError("the monitor is not answering") from error

    owned = None
    for row in build_tree(snapshot.get("tasks", []) if isinstance(snapshot, dict) else [], pane_id):
        for task in [row, *row.get("children", [])]:
            if str(task.get("id")) == str(task_id) and int(task.get("generation", 0)) == int(generation):
                owned = task
                break
        if owned:
            break
    if owned is None:
        raise LookupError("that task does not belong to this agent")
    if owned.get("state") not in ACTIVE_STATES:
        raise LookupError(f"the task is already {owned.get('state')}")

    # The hub comes from the snapshot, never from the request: `hub_instance_id`
    # is accepted so an older renderer's call still parses, and then ignored in
    # favour of what the monitor itself just said owns this task.
    result = monitor.cancel(owned["id"], owned["generation"], owned.get("hubInstanceId"))

    return result if isinstance(result, dict) else {"cancelled": False}
