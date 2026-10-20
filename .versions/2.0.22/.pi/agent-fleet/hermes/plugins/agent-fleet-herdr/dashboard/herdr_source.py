"""Source B — what each session is doing right now, from herdr.

`herdr agent list` needs nothing but `HOME` in the environment: it finds its own
socket. That is why the gateway process, which carries no `HERDR_*` variables,
can call it without setup — and why this is a subprocess and not a socket
client. A socket client would save ~20ms per poll and unlock
`pane.agent_status_changed` push, at the cost of reimplementing the JSON-lines
protocol in Python. At a 3s interval that trade is not worth taking yet.

Nothing here raises for a herdr that is down or slow: the caller degrades every
row to `state: "unknown"` and still renders the sessions. A missing herdr means
"we don't know what they're doing", never "there are no sessions".
"""

import json
import re
import subprocess

HERDR_BIN = "herdr"
HERDR_TIMEOUT_S = 3.0

# herdr's own vocabulary. Anything else (including a herdr that grows a new
# state) normalises to "unknown" rather than leaking a label the UI can't tone.
KNOWN_STATES = ("idle", "working", "blocked")

# Port of parsePeerName in .pi/harnesses/lib/herdr-presence.ts — the inverse of
# formatPeerStatus's `<name> <pct>% q<depth>`. Kept character-identical
# (including the tolerant `q\d*` tail) so both ends agree on truncated input.
# Only reachable on herdr <= 0.7.3; see peer_key().
_PEER_STATUS = re.compile(r"^(.*?)\s+\d+%\s+q\d*$")

# Pane fields the join is allowed to see. `terminal_id` and the session paths
# herdr also reports stay behind this line — see the allowlist note in
# sessions.py.
_PANE_FIELDS = ("agent", "pane_id", "focused", "workspace_id")


class HerdrUnavailable(Exception):
    """herdr could not be asked: missing binary, timeout, or a bad answer."""


def parse_peer_name(custom_status) -> str | None:
    """`"reviewer 12% q0"` -> `"reviewer"`.

    `custom_status` is capped at 32 chars by the herdr server, which is exactly
    why the coms peer name is written FIRST: a truncated tail still leaves the
    identity readable. When the tail is cut off mid-way the regex misses and we
    return the raw string — the caller resolves that by prefix, and treats an
    ambiguous prefix as unknown rather than guessing.
    """
    if not isinstance(custom_status, str) or not custom_status.strip():
        return None
    match = _PEER_STATUS.match(custom_status)
    name = (match.group(1) if match else custom_status).strip()
    return name or None


def peer_key(agent: dict) -> tuple[str | None, str] | None:
    """`(project, name)` for the coms peer occupying a pane, or None.

    Mirrors peerNameFrom/peerProjectFrom in herdr-presence.ts. `project` is None
    only for the legacy `custom_status` dialect, which had 32 characters to work
    with and no room for it — and that missing project is precisely why two
    projects each running an `orchestrator` used to be unjoinable.

    `name` (herdr's `agent rename`) is a human label rather than a coms
    identity, so it is the last resort, never the first.
    """
    tokens = agent.get("tokens")
    if isinstance(tokens, dict):
        name = tokens.get("coms")
        if isinstance(name, str) and name.strip():
            project = tokens.get("proj")
            scope = project.strip() if isinstance(project, str) and project.strip() else None
            return (scope, name.strip())

    legacy = parse_peer_name(agent.get("custom_status"))
    if legacy:
        return (None, legacy)

    named = agent.get("name")
    if isinstance(named, str) and named.strip():
        return (None, named.strip())
    return None


def normalize_state(agent_status) -> str:
    return agent_status if agent_status in KNOWN_STATES else "unknown"


def run_herdr(args: list[str], timeout: float, runner=subprocess.run) -> str:
    """The one place a herdr failure becomes `HerdrUnavailable`."""
    try:
        result = runner(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as error:
        raise HerdrUnavailable(f"{args[0]} not found on PATH") from error
    except subprocess.TimeoutExpired as error:
        raise HerdrUnavailable(f"{' '.join(args)} timed out after {timeout}s") from error
    except OSError as error:
        raise HerdrUnavailable(f"{' '.join(args)} failed: {error}") from error
    if result.returncode != 0:
        raise HerdrUnavailable(f"{' '.join(args)} exited {result.returncode}: {result.stderr.strip()[:200]}")
    return result.stdout


def list_agents(run=run_herdr, timeout: float = HERDR_TIMEOUT_S) -> list[dict]:
    """Raw pane records from `herdr agent list`."""
    raw = run([HERDR_BIN, "agent", "list"], timeout)
    try:
        payload = json.loads(raw)
    except ValueError as error:
        raise HerdrUnavailable("herdr agent list returned non-JSON output") from error
    # The CLI wraps its answer in the wire envelope (`{"id":…,"result":{…}}`);
    # accept the bare form too, so a future unwrapped CLI does not break us.
    container = payload.get("result", payload) if isinstance(payload, dict) else {}
    agents = container.get("agents") if isinstance(container, dict) else None
    if not isinstance(agents, list):
        raise HerdrUnavailable("herdr agent list returned no agents array")
    return [agent for agent in agents if isinstance(agent, dict)]


def pane_snapshot(run=run_herdr, timeout: float = HERDR_TIMEOUT_S) -> tuple[dict[tuple[str | None, str], dict], int]:
    """The panes we can join, and how many panes herdr reported in total.

    One `herdr agent list` for both numbers. The total includes panes with no
    peer annotation, which is the point: it is what lets the panel tell "herdr
    sees nothing at all" apart from "herdr sees panes, none of them is yours".
    """
    agents = list_agents(run, timeout)
    return panes_from_agents(agents), len(agents)


def panes_by_peer_key(run=run_herdr, timeout: float = HERDR_TIMEOUT_S) -> dict[tuple[str | None, str], dict]:
    """Panes keyed by the `(project, name)` coms peer they advertise."""
    return panes_from_agents(list_agents(run, timeout))


def panes_from_agents(agents: list[dict]) -> dict[tuple[str | None, str], dict]:
    """Panes keyed by the `(project, name)` coms peer they advertise.

    Panes without a peer annotation are dropped: they are not Agent Fleet
    sessions (or have not reported presence yet), and the registry side of the
    join is what decides who exists. Two panes claiming one key collapse to a
    single ambiguous marker — a wrong status on the right row is worse than an
    honest "unknown".
    """
    claims: dict[tuple[str | None, str], list[dict]] = {}
    for agent in agents:
        key = peer_key(agent)
        if not key:
            continue
        pane = {field: agent.get(field) for field in _PANE_FIELDS if agent.get(field) is not None}
        pane["state"] = normalize_state(agent.get("agent_status"))
        claims.setdefault(key, []).append(pane)

    panes: dict[tuple[str | None, str], dict] = {}
    for key, matches in claims.items():
        panes[key] = matches[0] if len(matches) == 1 else {"state": "unknown", "ambiguous": True}
    return panes


# herdr's own ids (`wA`, `wA:p13`). Validated before reaching argv even though
# nothing here goes through a shell: an id is a machine token, and the moment a
# renderer can put arbitrary text in one, "not a shell" is the only thing left
# between it and the command line.
_WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")


def focus_workspace(workspace_id, run=run_herdr, timeout: float = HERDR_TIMEOUT_S) -> None:
    """Bring a workspace forward. The only write this module makes.

    Raises `HerdrUnavailable` when herdr refuses or cannot be reached — the
    caller turns that into an answer on screen, because a focus that silently
    did nothing is worse than one that says it failed.
    """
    if not isinstance(workspace_id, str) or not _WORKSPACE_ID.match(workspace_id):
        raise HerdrUnavailable(f"not a herdr workspace id: {workspace_id!r}")
    run([HERDR_BIN, "workspace", "focus", workspace_id], timeout)


def herdr_version(run=run_herdr, timeout: float = HERDR_TIMEOUT_S) -> str | None:
    """Reported for `/capabilities` only — never gates behaviour."""
    try:
        text = run([HERDR_BIN, "--version"], timeout).strip()
    except HerdrUnavailable:
        return None
    return text.splitlines()[0].strip() if text else None
