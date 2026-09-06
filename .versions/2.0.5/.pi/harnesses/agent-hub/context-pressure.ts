export const CONTEXT_WARNING_PERCENT = 80;
export const AUTO_COMPACT_PERCENT = 90;

export type ContextPressure = "unknown" | "normal" | "approaching" | "imminent";
export type ContextPressurePhase = "normal" | "warning" | "compacting" | "recovered" | "failed";
export type ContextPressureAction = "none" | "expose-compaction" | "compact-now";
export type ContextPressureReason =
	| "usage-unknown"
	| "below-warning"
	| "warning-threshold"
	| "automatic-threshold"
	| "single-flight"
	| "recovery-observed"
	| "compaction-succeeded"
	| "compaction-failed";

export interface ContextUsageMeasurement {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export type ContextRecoveryOutcome = "none" | "succeeded" | "failed";

export interface ContextPressureState {
	phase: ContextPressurePhase;
	pressure: ContextPressure;
	episode: number;
	usage: ContextUsageMeasurement;
	/** Rearmed only after measured usage falls below the warning threshold. */
	autoCompactArmed: boolean;
	lastRecoveryOutcome: ContextRecoveryOutcome;
	lastError: string | null;
}

export interface ContextPressureDiagnostic {
	phase: ContextPressurePhase;
	pressure: ContextPressure;
	episode: number;
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	warningPercent: number;
	automaticPercent: number;
	lastRecoveryOutcome: ContextRecoveryOutcome;
}

export type ContextPressureEvent =
	| { type: "usage"; usage: ContextUsageMeasurement }
	| { type: "compaction-succeeded" }
	| { type: "compaction-failed"; error?: string };

export interface ContextPressureDecision {
	state: ContextPressureState;
	action: ContextPressureAction;
	reason: ContextPressureReason;
}

const EMPTY_USAGE: ContextUsageMeasurement = { tokens: null, contextWindow: null, percent: null };

export function createContextPressureState(): ContextPressureState {
	return {
		phase: "normal",
		pressure: "unknown",
		episode: 0,
		usage: { ...EMPTY_USAGE },
		autoCompactArmed: true,
		lastRecoveryOutcome: "none",
		lastError: null,
	};
}

function finiteNonNegative(value: number | null): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positive(value: number | null): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeUsage(input: ContextUsageMeasurement): ContextUsageMeasurement {
	const tokens = finiteNonNegative(input.tokens);
	const contextWindow = positive(input.contextWindow);
	const measuredPercent = finiteNonNegative(input.percent);
	const percent = measuredPercent ?? (tokens !== null && contextWindow !== null ? tokens / contextWindow * 100 : null);
	return { tokens, contextWindow, percent };
}

function pressureFor(percent: number | null): ContextPressure {
	if (percent === null) return "unknown";
	if (percent >= AUTO_COMPACT_PERCENT) return "imminent";
	if (percent >= CONTEXT_WARNING_PERCENT) return "approaching";
	return "normal";
}

export function contextPressureDiagnostic(state: ContextPressureState): ContextPressureDiagnostic {
	return {
		phase: state.phase,
		pressure: state.pressure,
		episode: state.episode,
		tokens: state.usage.tokens,
		contextWindow: state.usage.contextWindow,
		percent: state.usage.percent,
		warningPercent: CONTEXT_WARNING_PERCENT,
		automaticPercent: AUTO_COMPACT_PERCENT,
		lastRecoveryOutcome: state.lastRecoveryOutcome,
	};
}

export function shouldExposeCompaction(state: ContextPressureState): boolean {
	return state.phase !== "normal";
}

export function transitionContextPressure(
	state: ContextPressureState,
	event: ContextPressureEvent,
): ContextPressureDecision {
	if (event.type === "compaction-succeeded") {
		return {
			state: { ...state, phase: "recovered", lastRecoveryOutcome: "succeeded", lastError: null },
			action: "none",
			reason: "compaction-succeeded",
		};
	}
	if (event.type === "compaction-failed") {
		return {
			state: { ...state, phase: "failed", autoCompactArmed: false, lastRecoveryOutcome: "failed", lastError: event.error?.trim() || "compaction failed" },
			action: "none",
			reason: "compaction-failed",
		};
	}

	const usage = normalizeUsage(event.usage);
	const pressure = pressureFor(usage.percent);
	if (pressure === "unknown") {
		return {
			state: { ...state, pressure, usage },
			action: "none",
			reason: "usage-unknown",
		};
	}

	if (pressure === "normal") {
		return {
			state: {
				...state,
				phase: "normal",
				pressure,
				usage,
				autoCompactArmed: true,
				lastError: null,
			},
			action: "none",
			reason: state.phase === "normal" ? "below-warning" : "recovery-observed",
		};
	}

	const enteringEpisode = state.pressure === "normal" || state.pressure === "unknown";
	const episode = state.episode + (enteringEpisode ? 1 : 0);

	if (state.phase === "compacting" || !state.autoCompactArmed) {
		return {
			state: { ...state, pressure, usage, episode },
			action: "none",
			reason: "single-flight",
		};
	}

	if (pressure === "imminent") {
		return {
			state: {
				...state,
				phase: "compacting",
				pressure,
				usage,
				episode,
				autoCompactArmed: false,
				lastError: null,
			},
			action: "compact-now",
			reason: "automatic-threshold",
		};
	}

	const enteringWarning = state.phase !== "warning";
	return {
		state: { ...state, phase: "warning", pressure, usage, episode, lastError: null },
		action: enteringWarning ? "expose-compaction" : "none",
		reason: "warning-threshold",
	};
}
