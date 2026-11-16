"""The join — coms registry (who exists) × herdr (what they are doing).

An outer LEFT join from the registry, never the other way round:

  registry entry + herdr pane -> full row with a live state
  registry entry, no pane     -> `detached` — the session lives, but not in a pane
  herdr pane, no registry     -> not shown at all — it is not an Agent Fleet session

Joined by COMS PEER IDENTITY — `(project, name)` — not by cwd. The reason is
the normal case, not an exotic one: a pi pane and a Claude Code pane driving the
same repo share a cwd exactly, so a cwd join would merge two sessions into one
row or swap their statuses.

The key is the PAIR because `resolveUniqueName()` keeps peer names unique
inside a project and says nothing across projects: two projects each running an
`orchestrator` is ordinary, and a name-only key makes both unresolvable. Panes
annotated by a herdr too old to carry the project (see herdr_source.peer_key)
key as `(None, name)` and are matched by name alone — but only when that name is
unambiguous across the whole registry.

This module also owns the output allowlist — the last line before data reaches
a renderer that runs with the full privileges of the application.
"""

import os
from datetime import datetime, timezone

import coms_registry

# Everything the panel is allowed to learn. `endpoint` (a writable socket path
# into another agent's process), `pid`, `session_id` and herdr's `terminal_id`
# deliberately stop here: the panel has no use for them, and the renderer is not
# a place to hand out a write door.
_REGISTRY_FIELDS = (
    "name",
    "model",
    "purpose",
    "cwd",
    "started_at",
    "heartbeat_at",
    "context_used_pct",
    "queue_depth",
)
# `workspace_id` is here so the panel can offer "focus that pane" without ever
# being told a pane's terminal or session paths.
_PANE_FIELDS = ("agent", "pane_id", "focused", "workspace_id")

# No herdr answer at all. Distinct from `detached`, which is a herdr that
# answered and simply had no pane for this peer.
STATE_UNKNOWN = "unknown"
STATE_DETACHED = "detached"


def match_panes(
    keys: list[tuple[str, str]],
    panes: dict[tuple[str | None, str], dict],
) -> dict[tuple[str, str], dict]:
    """Registry `(project, name)` -> herdr pane.

    Two passes, from most to least certain:
      1. exact `(project, name)` matches, which consume their pane — a fully
         annotated pane is unambiguous by construction, even when another
         project runs a peer of the same name;
      2. unscoped `(None, name)` panes for whatever is left. Exact name first,
         then prefix, because the legacy 32-char cap can truncate
         `<name> <pct>% q<n>` mid-tail (see parse_peer_name).

    A key stays UNMATCHED when nothing claims it — the caller renders that as
    `detached`, which is the truth: the session is alive and no pane hosts it.
    It is marked AMBIGUOUS only when a claim exists that cannot be assigned:
    several candidate panes, or one unscoped pane and two projects running a
    peer by that name. Ambiguity is a statement about competing evidence, so it
    must never be reported in the absence of any.
    """
    matched: dict[tuple[str, str], dict] = {}
    pool = dict(panes)

    for key in keys:
        if key in matched:
            continue
        pane = pool.pop(key, None)
        if pane is not None:
            matched[key] = pane

    # Names the registry itself cannot disambiguate without a project.
    names = [name for _project, name in keys]
    duplicated = {name for name in names if names.count(name) > 1}

    for key in dict.fromkeys(keys):
        if key in matched:
            continue
        name = key[1]
        if (None, name) in pool:
            candidates = [(None, name)]
        else:
            candidates = [
                (scope, claimed)
                for (scope, claimed) in pool
                if scope is None and (claimed.startswith(name) or name.startswith(claimed))
            ]
        if not candidates:
            continue
        if len(candidates) > 1 or name in duplicated:
            # Left in the pool on purpose: the other project's row must reach
            # the same verdict rather than inherit this pane.
            matched[key] = {"state": STATE_UNKNOWN, "ambiguous": True}
            continue
        matched[key] = pool.pop(candidates[0])
    return matched


def _age_s(value, now_ms: float) -> int | None:
    """Whole seconds between an ISO timestamp and now, or None if unreadable.

    Never negative: a peer whose clock runs ahead of the gateway's is a clock
    problem, not a session that started in the future.
    """
    parsed = coms_registry.parse_timestamp_ms(value)
    if parsed is None:
        return None
    return max(0, int((now_ms - parsed) / 1000))


def _row(entry: dict, pane: dict | None, herdr_available: bool, now_ms: float) -> dict:
    if not herdr_available:
        state = STATE_UNKNOWN
    elif pane is None:
        state = STATE_DETACHED
    else:
        state = pane.get("state", STATE_UNKNOWN)

    row = {field: entry.get(field) for field in _REGISTRY_FIELDS}
    row["repo"] = os.path.basename(str(entry.get("cwd") or "").rstrip("/")) or None
    row["state"] = state
    # Derived here rather than in the renderer: the pane holds a snapshot up to
    # 3 seconds old and has no idea when it was collected, so it cannot do this
    # arithmetic correctly. `None` means the timestamp was unreadable — an
    # entry written by an older coms — and the renderer must show nothing at
    # all rather than "0s".
    row["uptime_s"] = _age_s(entry.get("started_at"), now_ms)
    row["heartbeat_age_s"] = _age_s(entry.get("heartbeat_at"), now_ms)
    # The liveness rule the registry reader already applies, exposed as its own
    # boolean. A stale row is still LIVE — it survived `entry_is_live` on the
    # PID probe — but it stopped heartbeating, which is worth seeing.
    row["stale"] = (
        row["heartbeat_age_s"] is not None
        and row["heartbeat_age_s"] > coms_registry.HEARTBEAT_FRESH_MS / 1000
    )
    # One boolean, computed once. The renderer must not have to know which
    # herdr states mean "a human is being waited on" — when phase 2 adds the
    # bridge's real questions, the meaning widens here and nowhere else.
    row["needs_answer"] = state == "blocked"
    for field in _PANE_FIELDS:
        row[field] = (pane or {}).get(field)
    row["focused"] = bool(row["focused"])
    return row


def build_sessions(
    projects: dict[str, list[dict]],
    panes: dict[tuple[str | None, str], dict] | None,
    collected_at: str | None = None,
    now_ms: float | None = None,
    pane_total: int | None = None,
) -> dict:
    """The `/sessions` payload.

    `panes=None` means herdr could not be asked: every row degrades to
    `unknown` and the payload says so, so the panel can show the sessions it
    knows about instead of an empty list or an error.

    `pane_total` is how many panes herdr reported in all — including the ones
    that carry no peer annotation and are therefore not in `panes`. It exists
    so `detached` can be explained: a herdr that sees no panes at all and a
    peer that genuinely left its pane are the same word with different causes.
    """
    herdr_available = panes is not None
    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    keys = [
        (project, entry.get("name"))
        for project, entries in projects.items()
        for entry in entries
        if entry.get("name")
    ]
    matched = match_panes(keys, panes or {})

    grouped = []
    for project in sorted(projects):
        rows = [
            _row(entry, matched.get((project, entry.get("name"))), herdr_available, now_ms)
            for entry in projects[project]
        ]
        rows.sort(key=lambda row: (not row["needs_answer"], row["name"] or ""))
        grouped.append({"project": project, "sessions": rows})

    # Projects with someone waiting on a human float to the top: that is the
    # only reason this panel is opened in a hurry.
    grouped.sort(key=lambda group: (not any(row["needs_answer"] for row in group["sessions"]), group["project"]))

    return {
        "projects": grouped,
        "herdr": herdr_available,
        "herdr_panes": pane_total if herdr_available else None,
        "collected_at": collected_at or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
