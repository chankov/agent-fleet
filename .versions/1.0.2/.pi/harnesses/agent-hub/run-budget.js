// Execution modes & per-turn budgets — the pure policy core behind the hub's
// runaway-orchestration guardrails. Budgets are PER USER TURN: a new user
// message opens a fresh window, so "budget exhausted" naturally means "stop,
// summarize, ask the user". Everything here is data + pure functions so the
// policy is unit-testable away from the 7k-line harness.
//
// A budget value of `null` means "off"/unlimited for that axis.

export const HUB_MODES = ["fast", "standard", "strict"];
export const DEFAULT_HUB_MODE = "standard";

// Task tiers — the dispatcher's per-turn complexity triage. Tier caps only
// lower the dispatch/research axes (min with the mode budget): a trivial ask
// must not burn a standard-mode budget on ceremony, while `project` defers
// entirely to the mode. Unset tier is treated as "feature".
export const TASK_TIERS = ["trivial", "small", "feature", "project"];
// The tier ASSUMED when the dispatcher never called set_task_tier. It is
// deliberately not the middle of the range: the tier is task-scoped, so a skipped
// triage latches for the whole task, and skipped triage is exactly the case where
// the dispatcher was not thinking about proportionality. Assuming `feature` there
// unlocked planner/plan-reviewer/security-auditor, loosened the review cap, and
// handed out the full feature envelope — the over-apparatus failure mode, granted
// by forgetting a tool call. Assuming `small` costs an explicit escalation (with a
// reason) when the work really is bigger, which is the cheap direction to be wrong in.
export const DEFAULT_TASK_TIER = "small";

export const TIER_CAPS = {
	trivial: { maxDispatches: 1, maxResearch: 1 },
	small: { maxDispatches: 2, maxResearch: 2 },
	feature: { maxDispatches: 6, maxResearch: 4 },
	project: { maxDispatches: null, maxResearch: null },
};

/** "Small", " TRIVIAL " → canonical tier name, or null when unrecognized. */
export function normalizeTaskTier(value) {
	const v = String(value ?? "").trim().toLowerCase();
	return TASK_TIERS.includes(v) ? v : null;
}

// Session-recycle context threshold (percent, measured over input+cacheRead+
// cacheWrite): beyond this, resuming the specialist session mostly re-bills
// stale context, so a fresh session is cheaper than the memory is worth.
export const RECYCLE_CONTEXT_PCT = 60;

// Hard ceiling: at or past a full window the accumulated session no longer
// fits, so no threshold override may keep it alive. Session 1 of the
// post-mortem logged 315% → 176% → 100% while the configured threshold was
// still being consulted as if it were advisory.
export const HARD_RECYCLE_CONTEXT_PCT = 100;

export const MODE_BUDGETS = {
	fast: {
		maxDispatches: 2,
		maxResearch: 1,
		wallMs: 15 * 60_000,
		agentTurnMs: 10 * 60_000,
		recycleRuns: 3,
		delegation: false,
	},
	standard: {
		maxDispatches: 8,
		maxResearch: 4,
		wallMs: 60 * 60_000,
		agentTurnMs: 30 * 60_000,
		recycleRuns: 5,
		delegation: true,
	},
	strict: {
		maxDispatches: 24,
		maxResearch: 12,
		wallMs: 240 * 60_000,
		agentTurnMs: null,
		recycleRuns: 5,
		delegation: true,
	},
};

/** "Fast", " STRICT " → canonical mode name, or null when unrecognized. */
export function normalizeHubMode(value) {
	const v = String(value ?? "").trim().toLowerCase();
	return HUB_MODES.includes(v) ? v : null;
}

/**
 * Effective budget for a mode with per-project overrides applied.
 * Override fields (all optional): maxDispatches, maxResearch, wallMs,
 * agentTurnMs, recycleRuns — a number replaces the mode default, `null` turns
 * the axis off, `undefined` keeps the default. `delegation` is mode-owned.
 * A declared `tier` (task tier) then LOWERS the dispatch and research caps to
 * the tier cap — overrides raise/disable the mode side, but the tier keeps a
 * simple ask from spending the whole envelope. No tier (null/undefined) means
 * no tier caps: the caller decides when to assume DEFAULT_TASK_TIER.
 */
export function resolveTurnBudget(mode, overrides = {}, tier = undefined) {
	const base = MODE_BUDGETS[normalizeHubMode(mode) ?? DEFAULT_HUB_MODE];
	const pick = (key) => (overrides[key] === undefined ? base[key] : overrides[key]);
	const caps = TIER_CAPS[normalizeTaskTier(tier)] ?? { maxDispatches: null, maxResearch: null };
	const lower = (value, cap) => {
		if (cap == null) return value;
		if (value == null) return cap;
		return Math.min(value, cap);
	};
	return {
		maxDispatches: lower(pick("maxDispatches"), caps.maxDispatches),
		maxResearch: lower(pick("maxResearch"), caps.maxResearch),
		wallMs: pick("wallMs"),
		agentTurnMs: pick("agentTurnMs"),
		recycleRuns: pick("recycleRuns"),
		delegation: base.delegation,
	};
}

function refusalTail(mode) {
	return "Do NOT retry this call before human confirmation. Summarize progress so far (including " +
		"unproven assertions and artifact paths), then use the Hub's one-click budget continuation " +
		"confirmation. Do not ask for a typed continue message or a slash command. The user can widen " +
		`future budgets with /af-hub-mode (current: ${mode}) or the max-*-per-turn / turn-wall-time-s keys ` +
		"in .ai/agent-fleet-overrides.md.";
}

/**
 * Gate one dispatcher tool call against the turn budget.
 * kind: "dispatch" | "research"; counters: { dispatches, research } — calls
 * already made this turn. Returns null when allowed, else { reason, message }.
 */
export function checkTurnBudget(kind, counters, budget, elapsedWallMs, mode = DEFAULT_HUB_MODE) {
	if (budget.wallMs != null && elapsedWallMs >= budget.wallMs) {
		return {
			reason: "wall",
			message: `⚠ Turn budget exhausted: wall clock at ${Math.round(elapsedWallMs / 60_000)} min ` +
				`(limit ${Math.round(budget.wallMs / 60_000)} min in ${mode} mode). ${refusalTail(mode)}`,
		};
	}
	if (kind === "dispatch" && budget.maxDispatches != null && counters.dispatches >= budget.maxDispatches) {
		return {
			reason: "dispatches",
			message: `⚠ Turn budget exhausted: ${counters.dispatches} of ${budget.maxDispatches} ` +
				`dispatch_agent calls used in ${mode} mode. ${refusalTail(mode)}`,
		};
	}
	if (kind === "research" && budget.maxResearch != null && counters.research >= budget.maxResearch) {
		return {
			reason: "research",
			message: `⚠ Turn budget exhausted: ${counters.research} of ${budget.maxResearch} ` +
				`spawn_research calls used in ${mode} mode. ${refusalTail(mode)}`,
		};
	}
	return null;
}

/**
 * Recycle the specialist's accumulated session before this run? True when the
 * session already served `recycleRuns` runs, its context reached a full window
 * (HARD_RECYCLE_CONTEXT_PCT, not overridable), or it passed the configured
 * RECYCLE_CONTEXT_PCT — resuming past any of those mostly re-bills stale
 * context on every subsequent model call.
 */
export function shouldRecycleSession(runsSinceFresh, contextPct, budget, thresholdPct = RECYCLE_CONTEXT_PCT) {
	if (runsSinceFresh <= 0) return false;
	if (contextPct >= HARD_RECYCLE_CONTEXT_PCT) return true;
	if (budget.recycleRuns != null && runsSinceFresh >= budget.recycleRuns) return true;
	return contextPct >= thresholdPct;
}

/**
 * The one case recycling cannot fix: a *fresh* session already measured over a
 * full window means a single run overflowed on its own, so there is no
 * accumulated history to drop. Either `contextWindow` is wrong for that
 * provider or the run genuinely ran over — both need a human, not a retry.
 * Returns the diagnostic line, or null when recycling covers the situation.
 */
export function contextOverflowDiagnostic(runsSinceFresh, contextPct, { agent = "agent", model = "unknown model" } = {}) {
	if (runsSinceFresh > 0) return null;
	if (!(contextPct >= HARD_RECYCLE_CONTEXT_PCT)) return null;
	return (
		`⚠ ${agent} measured ${Math.round(contextPct)}% context on a fresh session (${model}) — ` +
		"recycling cannot help, one run overflowed the window on its own. Either the resolved " +
		"contextWindow is wrong for this provider or the run genuinely ran over: check the model's " +
		"declared window and narrow the task's inputs."
	);
}

/** One-line status chip: "Mode: standard·small · 1/2 disp · 0/2 res · task 4/6". */
export function budgetStatusLine(mode, counters, budget, tier = null, task = null) {
	const cap = (n) => (n == null ? "∞" : String(n));
	const tierSuffix = tier ? `·${tier}` : "";
	const taskSuffix = task
		? ` · task ${task.counters.dispatches}/${cap(task.budget.maxDispatches)}`
		: "";
	return `Mode: ${mode}${tierSuffix} · ${counters.dispatches}/${cap(budget.maxDispatches)} disp · ` +
		`${counters.research}/${cap(budget.maxResearch)} res${taskSuffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier ratchet (the tier is TASK-scoped, not turn-scoped)
// ─────────────────────────────────────────────────────────────────────────────
//
// Turn-scoped tiers cannot bind on a steered run: every follow-up message reset
// the tier to null, the next dispatch re-assumed `feature`, and a two-word
// correction ("no, only the one line") bought six fresh dispatches. Worse, the
// reset direction was always upward — nobody re-declares `trivial` after a
// steering message, so the effective tier drifted to the ceiling.
//
// The tier now survives the turn and moves by ratchet: DOWN is free (cheap and
// self-limiting), UP costs an explicit reason that is recorded and shown. Only
// an explicit new task (`set_task_tier` with `new_task: true`) clears it.

export const TIER_RANK = { trivial: 0, small: 1, feature: 2, project: 3 };

/**
 * Move the task tier from `current` to `next`.
 * Returns { ok, tier, escalated, reason, message }: `tier` is always the tier
 * that should be in force afterwards, so a refused escalation keeps the old one.
 */
export function applyTierChange(current, next, reason = "") {
	const target = normalizeTaskTier(next);
	if (!target) {
		return {
			ok: false,
			tier: current ?? null,
			escalated: false,
			reason: "unknown_tier",
			message: `Unknown tier "${next}" — expected one of: ${TASK_TIERS.join(", ")}. ` +
				`Tier unchanged (${current ?? "unset"}).`,
		};
	}
	const from = normalizeTaskTier(current);
	if (!from) {
		return { ok: true, tier: target, escalated: false, reason: "initial", message: `Task tier: ${target}.` };
	}
	if (TIER_RANK[target] <= TIER_RANK[from]) {
		return {
			ok: true,
			tier: target,
			escalated: false,
			reason: TIER_RANK[target] === TIER_RANK[from] ? "unchanged" : "lowered",
			message: `Task tier: ${from} → ${target}.`,
		};
	}
	if (!String(reason || "").trim()) {
		return {
			ok: false,
			tier: from,
			escalated: false,
			reason: "raise_without_reason",
			message: `⚠ Tier escalation ${from} → ${target} refused: raising the tier needs an explicit ` +
				"`reason` naming what the ask turned out to contain that the lower tier does not cover. " +
				`Tier stays ${from}. Lowering the tier never needs a reason.`,
		};
	}
	return {
		ok: true,
		tier: target,
		escalated: true,
		reason: "raised",
		message: `⚠ Task tier ESCALATED ${from} → ${target}: ${String(reason).trim()}`,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-scoped budget (the outer bound the turn budget never provided)
// ─────────────────────────────────────────────────────────────────────────────
//
// Turn budgets are a per-message allowance, and a per-message allowance cannot
// bound a task: the observed 47-hour run never hit one, because every steering
// message opened a fresh window of 8 dispatches and 60 minutes. The task budget
// is the same envelope multiplied once and NOT reset by a user message.
// Exhaustion is a hard stop until the human accepts one audited continuation
// tranche; opening a genuinely new task remains a separate lifecycle action.

export const TASK_BUDGET_MULTIPLIER = 3;

/** Task envelope = turn envelope × multiplier; `null` (off) axes stay off. */
export function resolveTaskBudget(turnBudget, multiplier = TASK_BUDGET_MULTIPLIER) {
	const scale = (value) => (value == null ? null : Math.max(1, Math.round(value * multiplier)));
	return {
		maxDispatches: scale(turnBudget.maxDispatches),
		maxResearch: scale(turnBudget.maxResearch),
		wallMs: scale(turnBudget.wallMs),
	};
}

function taskRefusalTail() {
	return "This is a HARD STOP for the current task, not a turn refusal — another user message does " +
		"NOT reopen it. Summarize what is proven (with evidence and artifact paths), what is unproven, " +
		"and what remains, then use the Hub's one-click task-budget continuation confirmation. A confirmed " +
		"continuation opens one audited tranche while preserving task state. Use `set_task_tier` with " +
		"`new_task: true` only when the human genuinely moved to different work.";
}

/**
 * ACTIVE milliseconds in one turn: wall clock minus the time the human was away.
 *
 * The task clock must never charge for human time. A task's wall clock spans
 * every message on it, so a lunch break, an overnight pause, or a long `ask_user`
 * answer would all count as budget — and at `fast` mode's 45-minute task wall a
 * single coffee break would hard-stop a task with two dispatches spent. That is a
 * false positive that teaches people to reset the task window reflexively, which
 * costs more than the guardrail buys. Dispatch/research counts stay the honest
 * hard stops; the clock only bounds time the fleet actually spent working.
 */
export function turnActiveMs(turnStartedAt, now, askUserWaitMs = 0) {
	if (!turnStartedAt) return 0;
	return Math.max(0, now - turnStartedAt - Math.max(0, askUserWaitMs || 0));
}

/** A serializable, deterministic task clock. `active` is authoritative. */
export function createTaskClock() {
	return { active: false, accumulatedMs: 0, turnStartedAt: 0, askUserWaitMs: 0 };
}

/**
 * Open a task turn. A still-open prior interval is closed first as defensive
 * recovery for a missing end event; normal turns are closed by agent_end.
 */
export function openTaskClock(clock, now) {
	const base = clock?.active ? closeTaskClock(clock, now) : { ...createTaskClock(), ...clock };
	return { ...base, active: true, turnStartedAt: now, askUserWaitMs: 0 };
}

/** Add a completed ask_user wait to the currently open turn. */
export function addTaskClockWait(clock, waitMs) {
	if (!clock?.active) return { ...createTaskClock(), ...clock };
	return {
		...clock,
		askUserWaitMs: Math.max(0, clock.askUserWaitMs || 0) + Math.max(0, waitMs || 0),
	};
}

/** Finished turns plus the open turn, excluding completed and in-flight waits. */
export function taskClockElapsedMs(clock, now, openWaitMs = 0) {
	if (!clock) return 0;
	const accumulated = Math.max(0, clock.accumulatedMs || 0);
	if (!clock.active) return accumulated;
	return accumulated + turnActiveMs(
		clock.turnStartedAt,
		now,
		Math.max(0, clock.askUserWaitMs || 0) + Math.max(0, openWaitMs || 0),
	);
}

/** Close the current turn once. Repeated closes are no-ops. */
export function closeTaskClock(clock, now) {
	const base = { ...createTaskClock(), ...clock };
	if (!base.active) return base;
	return {
		active: false,
		accumulatedMs: taskClockElapsedMs(base, now),
		turnStartedAt: 0,
		askUserWaitMs: 0,
	};
}

/**
 * Open a fresh task window. During an active turn, the new task begins at the
 * reset instant; between turns, no timestamp is carried into the next task.
 */
export function resetTaskClock(clock, now) {
	const active = clock?.active === true;
	return {
		active,
		accumulatedMs: 0,
		turnStartedAt: active ? now : 0,
		askUserWaitMs: 0,
	};
}

/**
 * Gate one dispatcher tool call against the TASK budget (checked before the
 * turn budget: it is the more severe stop).
 * `activeTaskMs` is ACTIVE time (see turnActiveMs), never raw wall clock.
 * kind: "dispatch" | "research". Returns null when allowed, else { reason, message }.
 */
export function checkTaskBudget(kind, counters, taskBudget, activeTaskMs, tier = null) {
	const label = tier ? `tier ${tier}` : "current tier";
	if (taskBudget.wallMs != null && activeTaskMs >= taskBudget.wallMs) {
		return {
			reason: "task_wall",
			message: `⛔ TASK budget exhausted: ${Math.round(activeTaskMs / 60_000)} min of ACTIVE time on this task ` +
				`(limit ${Math.round(taskBudget.wallMs / 60_000)} min = ${TASK_BUDGET_MULTIPLIER}× the ${label} turn envelope; ` +
				`time the human was away is not charged). ` +
				taskRefusalTail(),
		};
	}
	if (kind === "dispatch" && taskBudget.maxDispatches != null && counters.dispatches >= taskBudget.maxDispatches) {
		return {
			reason: "task_dispatches",
			message: `⛔ TASK budget exhausted: ${counters.dispatches} of ${taskBudget.maxDispatches} ` +
				`dispatch_agent calls used on this task (${TASK_BUDGET_MULTIPLIER}× the ${label} turn envelope). ` +
				taskRefusalTail(),
		};
	}
	if (kind === "research" && taskBudget.maxResearch != null && counters.research >= taskBudget.maxResearch) {
		return {
			reason: "task_research",
			message: `⛔ TASK budget exhausted: ${counters.research} of ${taskBudget.maxResearch} ` +
				`spawn_research calls used on this task (${TASK_BUDGET_MULTIPLIER}× the ${label} turn envelope). ` +
				taskRefusalTail(),
		};
	}
	return null;
}

/**
 * How many research runs the TASK envelope still allows; null = unlimited.
 * The auto-research pipe (specialist emits NEEDS_RESEARCH, the hub fans out
 * read-only helpers in code) is exempt from the TURN budget on purpose — it is
 * hub mechanics, not a dispatcher decision, and it must not steal the
 * dispatcher's slots. It is NOT exempt from the TASK envelope: at 2 rounds × 4
 * questions per dispatch and 18 dispatches per task, an uncounted pipe is 144
 * research runs inside the bound that is supposed to be the outer one.
 */
export function remainingTaskResearch(taskBudget, counters) {
	if (taskBudget.maxResearch == null) return null;
	return Math.max(0, taskBudget.maxResearch - (counters?.research ?? 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier persona gate (B3) — heavy apparatus is not available at low tiers
// ─────────────────────────────────────────────────────────────────────────────
//
// "A trivial ask gets one specialist" was prose in the system prompt, and prose
// lost: a one-line Azure permission change was routed through planner →
// plan-reviewer → security-auditor and grew a 1216-line plan. These personas
// each open a pipeline (plans, reviews, findings that ratchet back into the
// plan), so at trivial/small tiers they are refused in code. The escape hatch is
// the honest one: raise the tier with a reason.

export const HEAVY_PERSONAS = ["planner", "plan-reviewer", "architect", "security-auditor", "deep-researcher"];
export const REVIEW_PERSONAS = ["code-reviewer", "plan-reviewer", "security-auditor"];
const GATED_TIERS = new Set(["trivial", "small"]);

/**
 * Refuse a heavy persona at a low tier. Returns null when allowed, else
 * { reason, message }. Unknown/absent tier never gates (strict mode leaves the
 * tier unset on purpose).
 */
export function checkTierPersonaGate(tier, persona) {
	const t = normalizeTaskTier(tier);
	if (!t || !GATED_TIERS.has(t)) return null;
	const name = String(persona || "").trim().toLowerCase();
	if (!HEAVY_PERSONAS.includes(name)) return null;
	return {
		reason: "tier_persona_gate",
		message: `⚠ ${name} is not available at tier "${t}" — and this dispatch was NOT counted against any budget.\n` +
			`At trivial/small tiers the apparatus is one specialist plus its own evidence: no planning pipeline, ` +
			`no plan review, no separate audit pass. Each of those personas opens a document/finding loop whose ` +
			`output then has to be executed and re-reviewed.\n` +
			`Either dispatch the specialist that does the actual work (builder, test-engineer, code-reviewer, ` +
			`documenter), or — if the ask really is bigger than "${t}" — call set_task_tier with a higher tier ` +
			`AND a reason naming what it turned out to contain. Do not raise the tier merely to unlock a persona.`,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Review finding budget (B6) — a review is a gate, and a gate has a size
// ─────────────────────────────────────────────────────────────────────────────
//
// Unbounded review authority is a ratchet: every round produced new blocking
// findings, each finding added an invariant to the plan, and the enlarged plan
// justified another round. PLAN37 recorded P37-001…011, R37-IMM-001 and six
// script-review remediations — none of which the user asked for. The cap is on
// BLOCKING findings only; everything else still gets reported, just not as a gate.

export const BLOCKING_FINDING_CAPS = { trivial: 1, small: 2, feature: 5, project: null };

// Review ROUNDS per task. The finding cap is an instruction to the reviewer, and
// an instruction is exactly what this whole change exists to stop relying on —
// but the finding cap is also the wrong thing to enforce mechanically: no rule
// the hub can evaluate distinguishes "invents a new manifest" from "this leaks a
// credential", and silently demoting the second is worse than tolerating the
// first. What the hub CAN own is its own action. The ratchet needs a second
// round to close, so the round count is where it is cut — deterministically,
// with no judgement about finding content.
export const REVIEW_ROUND_CAPS = { trivial: 1, small: 1, feature: 2, project: null };

/** Review rounds allowed on one task at this tier; null = uncapped. */
export function reviewRoundCap(tier) {
	const t = normalizeTaskTier(tier);
	if (!t) return null;
	return REVIEW_ROUND_CAPS[t] ?? null;
}

/**
 * Refuse an (N+1)-th review dispatch on the same task.
 * Returns null when allowed, else { reason, message }.
 */
export function checkReviewRoundCap(tier, persona, roundsSoFar) {
	if (!isReviewPersona(persona)) return null;
	const cap = reviewRoundCap(tier);
	if (cap == null || roundsSoFar < cap) return null;
	const t = normalizeTaskTier(tier);
	return {
		reason: "review_round_cap",
		message: `⚠ Review round cap reached: ${roundsSoFar} of ${cap} review dispatch${cap === 1 ? "" : "es"} ` +
			`already spent on this task at tier "${t}" — and this dispatch was NOT counted against any budget.\n` +
			`A review is a GATE, not a loop. The findings from the round you already have are the gate: fix them, ` +
			`re-verify only the assertions the fix touched, and close. Re-reviewing the same work to see whether ` +
			`the fix produced new findings is the ratchet — each round's findings become requirements, and the ` +
			`enlarged requirement set justifies the next round.\n` +
			`If this genuinely is a different review (a different subsystem, or work the earlier round never saw), ` +
			`raise the tier with a reason via set_task_tier, or call it with new_task: true for genuinely different work.`,
	};
}

/** Blocking-finding cap for a tier; null = uncapped (project / unset tier). */
export function blockingFindingCap(tier) {
	const t = normalizeTaskTier(tier);
	if (!t) return null;
	return BLOCKING_FINDING_CAPS[t] ?? null;
}

/** Is this a review persona (gets the finding-budget clause)? */
export function isReviewPersona(persona) {
	return REVIEW_PERSONAS.includes(String(persona || "").trim().toLowerCase());
}

/**
 * The finding-budget clause appended to a review persona's task text.
 * Returns null when the persona is not a reviewer or the tier is uncapped.
 */
export function reviewBudgetClause(tier, persona) {
	if (!isReviewPersona(persona)) return null;
	const cap = blockingFindingCap(tier);
	if (cap == null) return null;
	return [
		`## Finding budget (task tier: ${normalizeTaskTier(tier)})`,
		``,
		`Report at most ${cap} BLOCKING finding${cap === 1 ? "" : "s"}. Rank by severity and put everything`,
		`else under a "## Non-blocking (optional)" heading — non-blocking findings are advice, and must not`,
		`gate the change or be re-raised as blockers in a later round.`,
		``,
		`A blocking finding may only enforce an invariant the task, the plan, or the project rules ALREADY`,
		`state. It may NOT introduce a new invariant, a new evidence artifact, a new script/manifest/fixture,`,
		`or a new process requirement — that is scope growth wearing a reviewer's hat. If you believe a new`,
		`invariant is genuinely needed, write it under "## Non-blocking (optional)" as a recommendation for`,
		`the human to decide, and do not block on it.`,
	].join("\n");
}
