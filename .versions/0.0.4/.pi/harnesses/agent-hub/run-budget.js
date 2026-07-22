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
export const DEFAULT_TASK_TIER = "feature";

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
	return "Do NOT retry this call in this turn. Summarize progress so far (including " +
		"unproven assertions and artifact paths), then ask the user whether to continue — " +
		"the next user message starts a fresh budget window. The user can widen budgets " +
		`with /hub-mode (current: ${mode}) or the max-*-per-turn / turn-wall-time-s keys ` +
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
 * session already served `recycleRuns` runs, or its (correctly measured)
 * context passed RECYCLE_CONTEXT_PCT — resuming past either point mostly
 * re-bills stale context on every subsequent model call.
 */
export function shouldRecycleSession(runsSinceFresh, contextPct, budget, thresholdPct = RECYCLE_CONTEXT_PCT) {
	if (runsSinceFresh <= 0) return false;
	if (budget.recycleRuns != null && runsSinceFresh >= budget.recycleRuns) return true;
	return contextPct >= thresholdPct;
}

/** One-line status chip: "Mode: standard·small · 1/2 disp · 0/2 res". */
export function budgetStatusLine(mode, counters, budget, tier = null) {
	const cap = (n) => (n == null ? "∞" : String(n));
	const tierSuffix = tier ? `·${tier}` : "";
	return `Mode: ${mode}${tierSuffix} · ${counters.dispatches}/${cap(budget.maxDispatches)} disp · ` +
		`${counters.research}/${cap(budget.maxResearch)} res`;
}
