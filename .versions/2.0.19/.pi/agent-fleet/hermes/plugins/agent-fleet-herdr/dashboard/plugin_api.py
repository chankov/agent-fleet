"""HTTP boundary for the Agent Fleet herdr panel.

Mounted by the gateway at `/api/plugins/agent-fleet-herdr/` (web_server.py:19794)
once BOTH hold: this tree is reachable as `<hermes home>/plugins/agent-fleet-herdr/`
with a `dashboard/manifest.json` naming this file, AND `agent-fleet-herdr` is
listed in `plugins.enabled` in config.yaml. Missing either produces the same
`404 {"detail": "Plugin not found"}` — the enable check is middleware that runs
BEFORE routing, so a 404 never distinguishes "not mounted" from "not enabled".
Routers are included at app construction, so any change to this file needs
`hermes gateway restart`; the Desktop half hot-reloads instead.

Thin on purpose: the sources fail independently and the composition is tested
without FastAPI in sessions.test.py.

Reads are GET and stateless, with one exception that is stateful and one that
is not a read at all:

  - GET /events?after=<seq> drains the watcher's ring buffer (watch.py). Every
    /sessions request also FEEDS that watcher, and the first one starts the
    background poller so the fleet is still watched while the pane is closed.
  - WS /events/stream?after=<seq> is the same buffer, pushed. It accelerates
    the poll above and never replaces it — `ctx.socket` is a no-op on OAuth
    remotes, so a pane that only listened would silently stop hearing. It also
    has to gate ITSELF: every gateway middleware is registered for the `http`
    scope only, so neither the auth check nor the plugins-enabled check that
    protect the routes above runs on a WebSocket upgrade.
  - GET /sessions/…/activity?after=<seq> reads that agent's pi transcript
    (activity.py). Stateless, but the cursor is a byte offset into somebody
    else's file rather than a number this process assigned.
  - GET /sessions/…/tasks reads the agent-fleet-monitor's task tree for the
    hub in that agent's herdr pane, and POST …/tasks/{id}/{gen}/cancel stops
    one of them (tasks.py). Both go out over the monitor's own UDS; the cancel
    re-derives ownership from a fresh snapshot before trusting the id it was
    handed.
  - POST /sessions/…/prompt hands a prompt to a live peer. It takes
    `(project, name)` and resolves the socket path itself, so no endpoint ever
    reaches the renderer (coms_send.py). The Desktop pane no longer calls it —
    its ask box was withdrawn — and the route is kept because the dispatcher
    behind it is also what produces the dispatch events.
"""

import sys
from pathlib import Path

# The gateway imports this file by path (`spec_from_file_location`), which does
# NOT put its directory on `sys.path` — sibling imports would fail without this.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import activity  # noqa: E402
import coms_registry  # noqa: E402
import coms_send  # noqa: E402
import herdr_source  # noqa: E402
import tasks  # noqa: E402
import watch  # noqa: E402

router = APIRouter()

# One dispatcher per process: it owns the open reply sockets and the bounded
# transcript, so a per-request instance would drop every answer.
_dispatcher = coms_send.Dispatcher()

# Likewise one watcher: it IS the memory between two snapshots, and a
# per-request instance would see every fleet as brand new and report nothing.
# Its outbound sink is whatever the config file opts into — nothing, by default.
_watch_config = watch.load_config()
_watcher = watch.build_watcher(_watch_config)
_WATCH_INTERVAL_S = watch.interval_from(_watch_config)


class PromptBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=coms_send.MAX_PROMPT_CHARS)

# The Desktop pane polls at this cadence; served from here so the interval is
# one decision, not two.
POLL_MS = 3000


def _panes() -> tuple[dict | None, int | None]:
    """herdr's view and its pane count, or `(None, None)` when herdr is down."""
    try:
        return herdr_source.pane_snapshot()
    except herdr_source.HerdrUnavailable:
        return None, None


@router.get("/capabilities")
def capabilities() -> dict:
    """The two sources reported separately, because they fail separately.

    `coms_registry: false` means there are no Agent Fleet sessions to show at
    all. `herdr: false` means there may well be sessions, we just don't know
    what they are doing — the panel still lists them, as `unknown`.

    `events_stream` is not a source: it is the version marker. Backend routes
    mount at app construction, so the honest answer to "did Hermes restart since
    the plugin changed" is whether this key is here at all.
    """
    try:
        registry_ok = coms_registry.default_projects_root().is_dir()
    except OSError:
        registry_ok = False
    version = herdr_source.herdr_version()
    return {
        "coms_registry": registry_ok,
        "herdr": version is not None,
        "herdr_version": version,
        "poll_ms": POLL_MS,
        "events_stream": True,
    }


@router.get("/sessions")
def list_sessions() -> dict:
    """Live sessions grouped by project.

    503 only when the coms registry itself is unreadable — that is the one
    failure where we genuinely have nothing to say. A dead herdr is a 200 with
    every row degraded to `unknown`; never a 500.

    Also the watcher's front door: the payload it would diff is the payload the
    pane is looking at, so feeding it here costs nothing and guarantees the two
    can never disagree about what was on screen.
    """
    try:
        payload = watch.collect_snapshot(_dispatcher)
    except coms_registry.RegistryUnavailable as error:
        raise HTTPException(status_code=503, detail=f"coms registry unavailable: {error}") from error
    except Exception as error:  # never let an unexpected read fault become a 500
        raise HTTPException(status_code=503, detail="coms registry unavailable") from error

    _watcher.observe(payload)
    # Lazy, idempotent, and only from here: a gateway whose fleet pane nobody
    # opens should not be running `herdr agent list` in a loop.
    watch.ensure_runner(_watcher, _WATCH_INTERVAL_S, _dispatcher)
    return payload


@router.get("/events")
def list_events(after: int = 0) -> dict:
    """Fleet transitions numbered above `after`, oldest first.

    Cursor-based rather than time-based so a pane that was hidden for a minute
    catches up exactly once. The buffer is bounded and per gateway process, and
    `seq` comes back even when `events` is empty — a client that fell further
    behind than the buffer resumes from the present instead of replaying a
    truncated past as if it were new.
    """
    return _watcher.since(max(0, after))


# This plugin's directory name, which is also its namespace in `plugins.enabled`
# — the socket gate below has to re-check that itself.
PLUGIN_ID = "agent-fleet-herdr"

# Close codes the pane never sees (a WebSocket close code does not reach
# `ctx.socket`'s caller), so they exist for `hermes logs gui` and for tests.
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403


def _host_module():
    """The gateway module that imported us, if this process is the gateway.

    `sys.modules` rather than an import: `hermes_cli.web_server` is a very large
    module with side effects, and the only case where the socket may serve is
    the one where it is already loaded — it is the thing that mounted this
    router.
    """
    return sys.modules.get("hermes_cli.web_server")


def _socket_gate(websocket: WebSocket) -> str | None:
    """Why this upgrade must be refused, or `None` to serve it.

    Every gateway middleware — the auth gate AND the one that 404s a disabled
    plugin — is registered for the `http` scope, so a WebSocket route reaches
    this file with nothing checked. The two checks are therefore re-done here,
    with the gateway's own functions rather than a second implementation of
    them.

    **Unresolvable means refused.** If the host does not expose the check under
    the name we know, the socket does not open — and the pane keeps polling,
    which is the whole reason the poll was kept. Degrading to "serve it anyway"
    would turn a Hermes rename into an unauthenticated event feed.
    """
    host = _host_module()
    if host is None:
        return "no gateway to authenticate against"

    allowed = getattr(host, "_ws_request_is_allowed", None)
    authorized = getattr(host, "_ws_auth_ok", None)
    if not callable(allowed) or not callable(authorized):
        return "this Hermes does not expose the WebSocket auth check"

    try:
        if not allowed(websocket):
            return "origin or client is outside the dashboard boundary"
        if not authorized(websocket):
            return "no valid credential on the upgrade"
    except Exception as error:  # a refused upgrade is never a crashed gateway
        return f"the WebSocket auth check failed: {error}"

    return _enabled_gate()


def _enabled_gate() -> str | None:
    """The plugins-enabled check the HTTP middleware does and this scope skips.

    Same policy, same source of truth (`plugins.enabled` in config.yaml), so a
    plugin that is turned off stops pushing rather than keeping a live feed open
    on the strength of having been enabled when the pane was opened.

    A host without the plugin loader is not the gateway, so there is no enabled
    set to consult and nothing to refuse on — the auth check above is what
    protects that case.
    """
    try:
        from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set
    except ImportError:
        return None
    try:
        if PLUGIN_ID in _get_disabled_set() or PLUGIN_ID not in _get_enabled_set():
            return "the plugin is not enabled"
    except Exception as error:
        return f"the plugins-enabled check failed: {error}"

    return None


@router.websocket("/events/stream")
async def stream_events(websocket: WebSocket, after: int = 0) -> None:
    """The `/events` buffer, pushed as it fills.

    An accelerator, not a transport change: same events, same sequence numbers,
    same cursor, so a client can move between the two feeds mid-stream without
    seeing an event twice or missing one. The pane keeps its poll running at a
    slower cadence for exactly that reason — `ctx.socket` resolves to nothing on
    an OAuth remote, and a socket can drop at any time.

    The connection is never read from. There is nothing a client may say, and
    the keepalive frame doubles as the disconnect check: a departed client is
    noticed at the next send, which is at most `STREAM_KEEPALIVE_S` away.
    """
    reason = _socket_gate(websocket)
    if reason is not None:
        print(f"agent-fleet-herdr: refused an event stream — {reason}", file=sys.stderr)
        await websocket.close(code=WS_UNAUTHORIZED if "credential" in reason else WS_FORBIDDEN)
        return

    await websocket.accept()
    # A socket-only client is still a reason to watch: without this, a pane that
    # never polls (or polls slowly) would be subscribed to a watcher nobody is
    # feeding.
    watch.ensure_runner(_watcher, _WATCH_INTERVAL_S, _dispatcher)
    stream = watch.EventStream(_watcher, after=after)
    try:
        await websocket.send_json(stream.backlog())
        while True:
            await websocket.send_json(await stream.next_frame())
    except (WebSocketDisconnect, RuntimeError):
        pass  # the client left; a closed socket is the ordinary end of this loop
    finally:
        stream.close()


@router.get("/sessions/{project}/{name}/activity")
def session_activity(project: str, name: str, after: int = 0, limit: int = activity.DEFAULT_LIMIT) -> dict:
    """What that agent is actually doing, read from its own pi transcript.

    Only `(project, name)` crosses the wire; the transcript is found here, from
    the registry entry's `session_id` and `cwd` — neither of which the renderer
    is ever told (sessions.py's allowlist stops both).

    Everything except a malformed request is a 200. No transcript, no registry
    entry, an unreadable file: all `available: false` with a reason, because a
    session with nothing on disk to read is the ordinary case — a bridged Claude
    Code peer, a cwd that moved — and a panel that turned that into an error
    would be crying wolf every three seconds.
    """
    try:
        project = coms_send.validate_project(project)
        name = coms_send.validate_name(name)
    except coms_send.ComsSendError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        entry = activity.find_entry(coms_registry.live_sessions_by_project(), project, name)
    except Exception:
        return activity.unavailable("the coms registry could not be read")
    if entry is None:
        return activity.unavailable(f"no live session named {name!r} in {project!r}")

    # A bridged Claude Code peer is found through its herdr pane, because the
    # bridge mints its own coms session id and Claude Code's transcript carries
    # no trace of it (activity.claude_transcript). Asked for ONLY in that case:
    # a pi peer is matched from its own file, and paying a `herdr agent list`
    # per activity poll for every session would double the panel's subprocess
    # cost to answer a question pi already answers for free.
    pane_id = None
    if entry.get("model") == activity.CLAUDE_MODEL:
        panes, _total = _panes()
        pane = (panes or {}).get((project, name)) or (panes or {}).get((None, name)) or {}
        pane_id = pane.get("pane_id")

    try:
        return activity.activity_for_entry(entry, after=after, limit=limit, pane_id=pane_id)
    except Exception as error:  # a transcript is somebody else's file; it can be anything
        return activity.unavailable(f"the transcript could not be read: {error}")


def _pane_id_for(project: str, name: str) -> str | None:
    """The herdr pane hosting a peer, from a herdr answer taken now.

    The monitor correlates its child tasks by `hubPaneId`, which IS this id, so
    this lookup is the whole join. Taken fresh rather than from the panel's
    snapshot for the same reason `/focus` does it: a stale pane id would
    attribute one hub's subagents to another hub's row.
    """
    panes, _total = _panes()
    pane = (panes or {}).get((project, name)) or (panes or {}).get((None, name)) or {}

    return pane.get("pane_id")


@router.get("/sessions/{project}/{name}/tasks")
def session_tasks(project: str, name: str) -> dict:
    """The subagents this hub is running, as a tree, with their live output.

    The half the activity tail cannot reach: a transcript records what the hub
    did, not what its children are doing, and offers no way to stop one.

    Same contract as `…/activity`: everything but a malformed name is a 200.
    No monitor, no pane, an unreachable socket and a hub that has spawned
    nothing are four different sentences and zero errors — the monitor is
    opt-in, so "there isn't one" is the ordinary answer, not a fault.
    """
    try:
        project = coms_send.validate_project(project)
        name = coms_send.validate_name(name)
    except coms_send.ComsSendError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        pane_id = _pane_id_for(project, name)
    except Exception:
        return tasks.unavailable("herdr is not answering, so the hub's pane is unknown")

    try:
        return tasks.tasks_for_pane(pane_id)
    except Exception as error:  # the monitor is another process; it can do anything
        return tasks.unavailable(f"the monitor could not be read: {error}")


@router.post("/sessions/{project}/{name}/tasks/{task_id}/{generation}/cancel")
def cancel_session_task(project: str, name: str, task_id: str, generation: int) -> dict:
    """Stop one generation of one subagent.

    The only write this phase adds, and the feature that justifies the whole
    monitor transport — the activity tail can show a runaway subagent but not
    end it.

    `task_id` is a value the renderer read from `…/tasks`, so it is checked
    against a fresh snapshot scoped to THIS agent's pane before it reaches the
    socket (tasks.cancel_task). 422 covers every way the ask is wrong — a task
    that belongs to another hub, one that already finished, a monitor that is
    gone — because from the panel's side they are one thing: it did not get
    cancelled, and the reason belongs on screen.
    """
    try:
        project = coms_send.validate_project(project)
        name = coms_send.validate_name(name)
    except coms_send.ComsSendError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        pane_id = _pane_id_for(project, name)
    except Exception as error:
        raise HTTPException(status_code=503, detail="herdr is not answering") from error
    if not pane_id:
        raise HTTPException(status_code=422, detail=f"{name} is not in a herdr pane")

    try:
        return tasks.cancel_task(pane_id, task_id, generation)
    except LookupError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"the monitor refused the cancel: {error}") from error


@router.post("/sessions/{project}/{name}/prompt")
def send_prompt(project: str, name: str, body: PromptBody) -> dict:
    """Hand a prompt to a live peer and return immediately.

    422 covers every way the ask is wrong — bad name, dead peer, peer refused —
    because from the panel's side they are one thing: the prompt did not land,
    and the reason belongs on screen. Nothing here is retried for you; a peer
    that was alive 3 seconds ago and is gone now should say so, not be chased.
    """
    try:
        return _dispatcher.dispatch(project, name, body.prompt)
    except coms_send.ComsSendError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/sessions/{project}/{name}/focus")
def focus_session(project: str, name: str) -> dict:
    """Bring the pane hosting this peer to the front.

    Same shape as the prompt endpoint: the renderer names `(project, name)` and
    the workspace is resolved here, from a herdr answer taken now rather than
    from the panel's snapshot. 422 when nothing hosts the peer — a `detached`
    row has nothing to focus, and that is an answer, not a failure.
    """
    try:
        project = coms_send.validate_project(project)
        name = coms_send.validate_name(name)
    except coms_send.ComsSendError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    panes, _total = _panes()
    if panes is None:
        raise HTTPException(status_code=503, detail="herdr is not answering")
    # `(None, name)` is the legacy dialect, which could not carry a project.
    pane = panes.get((project, name)) or panes.get((None, name)) or {}
    workspace_id = pane.get("workspace_id")
    if not workspace_id:
        raise HTTPException(status_code=422, detail=f"{name} is not in a herdr pane")

    try:
        herdr_source.focus_workspace(workspace_id)
    except herdr_source.HerdrUnavailable as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"focused": workspace_id}


@router.get("/dispatches")
def list_dispatches() -> dict:
    """Prompts sent from this panel, newest first, with answers as they land."""
    return {"dispatches": _dispatcher.recent()}
