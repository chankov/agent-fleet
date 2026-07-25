---
"@chankov/agent-fleet": minor
---

Harden agent-hub against harness-level failures that presented as specialist failures.

Session files: an unusable `<agentKey>.json` is now validated and quarantined to `<file>.corrupt-<ISO>` before any spawn, and a run that pi rejects for a session reason is retried exactly once from a clean session. The check is unconditional, because `--session` reaches pi on every run — so neither `team_adjust drop`/`add` nor `/af-agents-restart` could previously recover a corrupt file. Roster messages no longer promise a reusable session file that pi would refuse.

Drift watchdog: the session's own `artifacts/`, `findings/`, and `delegations/` subtrees are implicitly in scope, since the deliverable protocol orders specialists to write there, and the judge prompt now says so. The `scope` rule is non-terminal — it reports a drift advisory on the dispatch result instead of stopping the run, matching the post-run scope gate, which reverts nothing. `loop`, `failures`, and `toolcap` stay terminal.

Turn budget: input artifacts resolve before a dispatch is counted, and `spawn_research` validates its persona and artifacts before spending a research slot — a path typo no longer costs a budget slot. Artifact paths now resolve across artifact kinds when the basename is unique (the hub writes auto-returns under `returns/`, so `reviews/<x>-run1.md` used to fail), with the correction reported back to the dispatcher and an explicit refusal when two kinds match.

Return contract: `ASSERTION A1: PASS — <evidence>` and the bare `A1: PASS` line forms are parsed, with a declared block always winning and an id the schema already classified never re-stated from a loose line. When nothing parses and assertions were tracked, one bounded read-only pass extracts the block from the report already on disk rather than declaring every assertion unproven; extracted returns are labelled as weaker evidence.

coms bridge: a Claude Code pane that is mid-turn is now waited on with bounded backoff instead of failing immediately, and `coms_send` accepts `reply_timeout_ms`, which the bridge honours (clamped to one hour) instead of always applying its own default. That default rises from 10 to 30 minutes, matching `coms_await`.

Assertion ledger: every assertion must name its `source` (the plan line, user request, or finding it encodes) — a sourceless batch is refused by id, because a specialist told to prove `A9` previously had to spend a dispatch and an ASK_USER cycle asking where `A9` came from. Batches over 8 open assertions are accepted with a warning suggesting the split. The orchestrator persona documents both rules.

Context accounting: each specialist and research helper is now measured against **its own** model's context window, resolved from pi's model registry with the source recorded, instead of against the dispatcher's window — which is why readings like "Planner context at 315%" were unactionable. A reading above 100% emits a one-time diagnostic naming the window and its source, a session at or past a full window is recycled unconditionally, and a resumed session whose projected prompt would overflow is recycled **before** the spawn rather than after 985s of billed work.

Concurrency: requests to one provider are capped per process (default 2 in flight for `custom/*`, unlimited elsewhere, configurable via `AGENT_HUB_PROVIDER_LIMITS`, e.g. `custom=4` or `custom=off`). Queued children still run; a nested spawn reuses its parent's permit so it can never wait on its own ancestor. Read-only children (and research helpers) now retry once on their fallback model when the provider fails **mid-run** — previously only a pre-work failure was recoverable, so a local-endpoint OOM discarded the whole run. Write-capable children keep the strict rule, since a retry there could duplicate edits.

Peer visibility: `coms_list` reports each peer's `pane_id` and `status` (`idle` | `working` | `booting`), so a sender can check addressability instead of screen-scraping the pane — the gap behind 127 `herdr_read_pane` calls in one session. `herdr_spawn_peer` waits (bounded) for the spawned peer to register and returns `peer_ready` with its coms name instead of only a pane id, and peers that were spawned but never sent to are named at turn end and in `/af-hub-report`; closing still requires the human's confirmation.

Delivery failures: a run that errored or timed out writes its output to `artifacts/failures/<agentKey>-run<N>.md`, never `returns/`, and the dispatch result names it a delivery failure with no assertion evidence. A 142-byte coms error stub stored as a return previously cost a full dispatch investigating a review that had in fact succeeded — only its reply was lost.
