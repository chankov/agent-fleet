export type ContextPlane = "hub" | "specialist" | "research" | "delegate" | "peer";
export type ContextCategory = "system" | "project" | "persona" | "roster" | "skill" | "tool" | "addon" | "conversation" | "protocol" | "unattributed";
export type ContextPersistence = "fixed" | "session" | "turn" | "message" | "projected";
export type ContextVisibility = "model-visible" | "loaded-excluded" | "ui-only" | "unknown";
export type ContextConfidence = "exact-chars" | "heuristic" | "provider-scaled" | "provider-total" | "unavailable";

/** Metadata-only accounting record. Deliberately contains no component text. */
export interface ContextBudgetComponent {
	id: string;
	parentId?: string;
	plane: ContextPlane;
	category: ContextCategory;
	label: string;
	source?: string;
	persistence: ContextPersistence;
	visibility: ContextVisibility;
	chars: number;
	estimatedTokens: number;
	adjustedTokens?: number;
	confidence: ContextConfidence;
}

export interface ContextPlaneSummary {
	plane: ContextPlane;
	measuredTokens?: number;
	attributedTokens: number;
	residualTokens?: number;
	window?: number;
	occupancyPercent?: number;
}

export const TOKEN_ESTIMATOR = "chars/4-v1";

/** A named, provider-independent heuristic retained beside provider measurements. */
export function estimateTokens(chars: number): number {
	return Math.ceil(Math.max(0, Number.isFinite(chars) ? chars : 0) / 4);
}

/** Exact JavaScript string character count (not bytes) without retaining text. */
export function characterCount(value: unknown): number {
	return typeof value === "string" ? value.length : String(value ?? "").length;
}

/**
 * Safely measure a schema's serialised representation. Unsupported values are
 * represented by stable markers; this never throws on circular user schemas.
 */
export function safeSchemaChars(schema: unknown): number {
	const seen = new WeakSet<object>();
	const json = JSON.stringify(schema, (_key, value) => {
		if (typeof value === "bigint") return "[bigint]";
		if (typeof value === "function") return "[function]";
		if (typeof value === "symbol") return "[symbol]";
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[circular]";
			seen.add(value);
		}
		return value;
	});
	return characterCount(json ?? "[undefined]");
}

export function component(input: Omit<ContextBudgetComponent, "chars" | "estimatedTokens"> & { chars?: number }): ContextBudgetComponent {
	const chars = Math.max(0, Number(input.chars) || 0);
	return { ...input, chars, estimatedTokens: estimateTokens(chars) };
}

/**
 * Reconcile visible component estimates with a provider total. The raw estimate
 * always remains intact. Estimated components are scaled only when needed;
 * non-negative residual absorbs all rounding.
 */
export function reconcileComponents(components: readonly ContextBudgetComponent[], measuredTokens?: number): ContextBudgetComponent[] {
	const measured = Number(measuredTokens);
	const hasMeasured = Number.isFinite(measured) && measured >= 0;
	const visible = components.filter((entry) => entry.visibility === "model-visible");
	const estimate = visible.reduce((sum, entry) => sum + Math.max(0, entry.estimatedTokens), 0);
	const scale = hasMeasured && estimate > measured && estimate > 0 ? measured / estimate : 1;
	return components.map((entry) => {
		if (entry.visibility !== "model-visible") return { ...entry, adjustedTokens: 0, confidence: entry.confidence === "unavailable" ? "unavailable" : "exact-chars" };
		const adjustedTokens = Math.max(0, Math.floor(Math.max(0, entry.estimatedTokens) * scale));
		return {
			...entry,
			adjustedTokens,
			confidence: hasMeasured && scale < 1 ? "provider-scaled" : entry.confidence,
		};
	});
}

/** Produce a non-negative provider residual and an exact post-rounding total. */
export function reconcilePlane(components: readonly ContextBudgetComponent[], plane: ContextPlane, measuredTokens?: number, window?: number): { components: ContextBudgetComponent[]; summary: ContextPlaneSummary; residual?: ContextBudgetComponent } {
	const reconciled = reconcileComponents(components, measuredTokens);
	const measured = Number(measuredTokens);
	const hasMeasured = Number.isFinite(measured) && measured >= 0;
	const attributedTokens = reconciled
		.filter((entry) => entry.plane === plane && entry.visibility === "model-visible")
		.reduce((sum, entry) => sum + Math.max(0, entry.adjustedTokens ?? 0), 0);
	const residualTokens = hasMeasured ? Math.max(0, measured - attributedTokens) : undefined;
	const validWindow = Number(window);
	const occupancyPercent = hasMeasured && Number.isFinite(validWindow) && validWindow > 0 ? (measured / validWindow) * 100 : undefined;
	const residual = residualTokens === undefined ? undefined : {
		id: `${plane}/provider-unattributed`, plane, category: "unattributed", label: "Provider / serialization / unattributed",
		persistence: "turn", visibility: "model-visible", chars: 0, estimatedTokens: 0, adjustedTokens: residualTokens,
		confidence: "provider-total" as const,
	};
	return { components: reconciled, summary: { plane, measuredTokens: hasMeasured ? measured : undefined, attributedTokens, residualTokens, window: Number.isFinite(validWindow) && validWindow > 0 ? validWindow : undefined, occupancyPercent }, residual };
}

/** Context capacity is meaningful only with this plane's own known window. */
export function planeOccupancy(tokens: number | undefined, window: number | undefined): number | undefined {
	const total = Number(tokens);
	const capacity = Number(window);
	return Number.isFinite(total) && total >= 0 && Number.isFinite(capacity) && capacity > 0 ? (total / capacity) * 100 : undefined;
}
