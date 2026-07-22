# Fleet Coordination Patterns

Runtime coordination protocols for a *fleet* of long-lived agents — peers in herdr panes,
coms peers, bridged non-pi agents — talking to each other while work is in flight. This is
the **runtime layer**: message-level protocols between already-running agents.
[orchestration-patterns.md](orchestration-patterns.md) covers the **composition layer**
(which personas to invoke and how to wire them: direct invocation, slash-command fan-out,
Claude Code Agent Teams) — read that one when deciding *who runs*; read this one when
deciding *how running agents coordinate*.

Adapted from the coordination protocols in disler's cmux experiments
(`PATTERNS-read-and-notify.md`), generalized away from cmux and grounded in this repo's
mechanisms: coms envelopes (`coms_send`/`coms_await`), the agent-hub Verification
Contract, and the herdr fleet layer (`team-up`, events, pane control).

Each pattern: when to use → protocol → how this repo instantiates it → failure modes.
Patterns name live mechanisms or say "not implemented here" — nothing aspirational is
presented as current.

---

## 1. Read-to-decide with sentinels

**When:** an orchestrator must branch on another agent's outcome. Prose is not a branch
condition — an LLM paraphrasing "it mostly works" hides a RED.

**Protocol:** the producing agent ends its output with a machine-greppable verdict line
(`VERDICT=GREEN|RED`, `STATUS: blocked`, …). The consumer greps for the sentinel and
branches on it — never on its interpretation of the surrounding prose. If the sentinel is
missing, that is itself a verdict (treat as failure/unknown, never as success).

**In this repo (live):**
- `NEEDS_RESEARCH: <question>` — a specialist pauses for information; the hub runs the
  research and resumes it (agent-hub auto-research pipe).
- `ASK_USER: <question>` — same protocol toward the human.
- The structured-return contract — agent-hub specialists return a typed
  `{status, evidence, …}` block that `crossCheck` verifies against the dispatcher's
  acceptance assertions; the *absence* of required evidence fails the gate.
- The `DIGEST:` contract — delegate children must end with a `DIGEST:` section; a missing
  digest is flagged to the parent instead of silently passing.
- Phase 4 of the herdr integration adds `<<COMS_DONE:msg_id>>` as the bridge's completion
  sentinel for driving non-pi CLIs.

**Failure modes:** sentinel collisions with legitimate output (pick unlikely strings);
agents *mentioning* the sentinel instead of *emitting* it (grep the last lines only);
treating a missing sentinel as success.

---

## 2. Push events over polling

**When:** an agent waits on another agent's state (done, blocked, alive) and the naive
implementation is a read-screen/ping loop.

**Protocol:** subscribe to a push channel and act on delivery. When polling is truly
unavoidable, bound it: explicit timeout, capped interval, and a terminal condition that
cannot be missed.

**In this repo (live):**
- `coms_await` — blocks on the response envelope for a `msg_id` (push) instead of
  polling `coms_get`.
- The coms presence backend under herdr — the pool widget populates from
  `events.subscribe` (`pane.agent_status_changed`, `pane.created/closed/exited`) instead
  of the 10s ping cycle; the ping loop survives only in the files backend where no push
  channel exists.
- herdr's blocking waiters — `herdr wait agent-status <pane> --status done` and
  `pane.wait_for_output --match <text>` are server-side waits, not client loops.

**Failure modes:** waiting for a state the pane is already in (herdr status waits fire on
*changes* — read current state first); missed events during a reconnect (resync a
snapshot on every reconnect, as `HerdrAgentWatch` does); unbounded waits (always pass a
timeout).

---

## 3. Rendezvous / barriers

**When:** work must not proceed past a point until N agents have arrived at it — a
request needs its response, parallel builders must finish before the verifier runs.

**Protocol:** a named wait point. One side blocks on the barrier; the other side's
arrival (response, completion event) releases it. The barrier has a timeout and a
defined behavior on partial arrival.

**In this repo (live):**
- `coms_send` + `coms_await` — the request/response barrier between peers: the sender
  blocks on the `msg_id`, the receiver's `agent_end` response capture releases it.
- The agent-hub dispatcher awaiting parallel dispatches before the Verification
  Contract's gate — no verdict until every specialist's structured return is in.
- `/handoff` — a full-session barrier: the dispatcher composes a brief, sends it, and
  awaits the peer's acknowledgment before ceding.

**Failure modes:** deadlock by mutual await (A awaits B while B awaits A — the coms hop
limit caps how deep synchronous chains can nest); barriers with no timeout; releasing on
ack instead of on completion (an ack means "received", not "done" — await the response
envelope, not the ack).

---

## 4. Fan-out / fan-in with digest discipline

**When:** a task shards into parallel independent slices whose results one agent must
merge — multi-angle reviews, per-module audits, racing hypotheses in debugging.

**Protocol:** shard → run in parallel → each worker writes its full output to an on-disk
artifact and returns only a bounded digest → the merger reads digests, pulls full
artifacts only where the digest warrants it. Raw dumps never travel upward.

**In this repo (live):**
- `spawn_research` findings files — research helpers write findings to disk; the hub
  reads the file paths, not transcript dumps.
- The artifact bus — specialists exchange `kind`-tagged artifact files; inputs are
  previews + paths, never inlined full content.
- The delegate `DIGEST:` contract — children return ≤30 digest lines with `path:line`
  citations plus the result-file path; over-long returns are truncated with a warning.
- `just team-up <team>` is the fleet-level shard step: one pane per peer, each an
  addressable worker.

**Failure modes:** digest inflation (cap lines, require citations); merger re-reading
every full artifact (defeats the point — pull selectively); shards that were not
actually independent (merge conflicts surface late; shard along module/file boundaries).

---

## 5. Racing with cancellation

**When:** several approaches to the same goal run in parallel and the first valid result
should win — competing fixes, multiple models on one question.

**Protocol:** N agents start; the orchestrator awaits the first result that passes
validation; every other runner is torn down immediately. Requires real kill semantics
and a validation step *before* declaring a winner (first ≠ correct).

**In this repo:** **not implemented as a first-class mechanism.** The pieces exist —
herdr `pane.close` / `workspace.close` (and the agent-hub `/agents-kill` command) can
tear down runners, and `coms_get` can poll multiple pending `msg_id`s — but **coms has no
cancel envelope**: a losing peer keeps working (and burning tokens) until its turn ends;
its late response is dropped as an orphan. Racing today means paying for every lane.
What it would take: a `cancel` envelope type honored mid-turn by peers, or racing only
runners whose lifecycle the orchestrator owns (herdr panes it may close — see the
damage-control rules before giving any LLM that verb).

**Failure modes:** declaring the fastest answer the best answer (validate first);
zombie runners after the race (tear down explicitly); racing where lanes share state
(two builders editing one worktree is a conflict, not a race — isolate worktrees).

---

*Composition-layer patterns (which personas, which commands, Agent Teams):*
[orchestration-patterns.md](orchestration-patterns.md). *The contract the dispatcher
enforces over all of these:* [skills/orchestration-verification](../skills/orchestration-verification/SKILL.md).
