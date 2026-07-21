---
"agent-fleet": minor
---

agent-hub: execution modes with enforced per-turn budgets, session recycling, and cheaper persona defaults — the fix for runaway over-orchestration (100+ dispatches / 100M+ tokens per task, mostly re-billed stale context).

- **Execution modes** `fast` / `standard` (default) / `strict` with per-user-turn budgets enforced in code: `dispatch_agent` and `spawn_research` refuse past the cap with "summarize and ask the user"; a new user message opens a fresh window. New `/hub-mode` command, `hub-mode` status chip, and mode-aware dispatcher prompt (fast: single specialist, ledger optional; standard: batched builds, one recon, one review gate; strict: full Verification Contract).
- **New overrides keys** under `## agent-hub`: `mode`, `max-dispatches-per-turn`, `max-research-per-turn`, `turn-wall-time-s`, `agent-turn-timeout-s`, `session-recycle-runs` (validated by `agent-fleet doctor`).
- **Whole-run deadline** (`turn_timeout`, exit 124, partial output preserved) for dispatched specialists, research helpers, and nested delegate children — a hung child can no longer hold its parent for hours. Complements the per-tool `recon-search-timeout-s` watchdog.
- **Session recycling + honest context measurement**: specialist context pressure now counts input + cacheRead + cacheWrite (previously cache reads were invisible, so the restart advice never fired); specialist sessions are recycled after N resumed runs or ≥60% measured context instead of resuming forever.
- **Dispatch key normalization**: `dispatch_agent(agent: "Test Engineer")` resolves to `test-engineer` instead of erroring.
- **Persona tuning**: orchestrator thinking xhigh→medium, builder/code-reviewer high→medium, plan-reviewer Sol→Terra + medium, test-engineer medium→low with scouts on Spark and the delegation pre-pass now conditional (first dispatch in an area only); orchestrator posture rewritten for batched execution (4–6 tasks per builder dispatch, narrow assertions, no researcher spawns to read return artifacts, "two reads" and deep research reserved for strict mode).

Existing behavior is restored with `mode: strict` in `.ai/agent-fleet-overrides.md`.
