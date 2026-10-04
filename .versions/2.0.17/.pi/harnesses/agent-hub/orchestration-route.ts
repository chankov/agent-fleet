export type ScopeBreadth = "narrow" | "cross-cutting" | "wide";
export type RouteRisk = "low" | "high" | "secret" | "cloud";

export interface RouteInputs {
	scopeBreadth: ScopeBreadth;
	risk: RouteRisk;
	reversible: boolean;
	approvedPlan: boolean;
	unresolvedForks: string[];
	selfDeclaredSmall?: boolean;
}

export interface RouteDecision {
	route: "builder-reviewer" | "planner-required";
	reason: string;
	reclassified: boolean;
	record: {
		scopeBreadth: ScopeBreadth;
		risk: RouteRisk;
		reversible: boolean;
		approvedPlan: boolean;
		unresolvedForks: string[];
	};
}

function recordOf(input: RouteInputs): RouteDecision["record"] {
	return {
		scopeBreadth: input.scopeBreadth,
		risk: input.risk,
		reversible: input.reversible,
		approvedPlan: input.approvedPlan,
		unresolvedForks: [...input.unresolvedForks],
	};
}

export function selectSpecialists(input: RouteInputs, signals: { secret?: boolean; cloud?: boolean; contradiction?: boolean } = {}) {
	if ((signals.secret || signals.cloud) && input.risk === "low") {
		return { stages: ["planner", "builder", "reviewer"] as const, reason: "risk was not lowered to bypass a secret or cloud signal" };
	}
	const decision = classifyOrchestrationRoute(input);
	if (signals.contradiction || decision.route === "planner-required") {
		return { stages: ["planner", "builder", "reviewer"] as const, reason: signals.contradiction ? "contradiction requires a planner" : decision.reason };
	}
	return { stages: ["builder", "reviewer"] as const, reason: decision.reason };
}

export function authorizePlanStatusUpdate(input: { planPath: string; allowedScope: string[]; evidenceRefs: string[] }): { allowed: boolean; reason: string } {
	const path = input.planPath.replace(/\\/g, "/");
	const inScope = input.allowedScope.some(root => path === root || path.startsWith(`${root.replace(/\\/g, "/")}/`));
	if (!inScope) return { allowed: false, reason: "plan file is outside the permitted scope" };
	if (!input.evidenceRefs.some(ref => ref.trim())) return { allowed: false, reason: "plan status requires evidence" };
	return { allowed: true, reason: "builder may update plan status" };
}

export function classifyOrchestrationRoute(input: RouteInputs, previous?: RouteDecision): RouteDecision {
	const record = recordOf(input);
	const blockers: string[] = [];
	if (input.scopeBreadth !== "narrow") blockers.push(`scope is ${input.scopeBreadth}`);
	if (input.risk !== "low") blockers.push(`risk is ${input.risk}`);
	if (!input.reversible) blockers.push("change is not reversible");
	if (!input.approvedPlan) blockers.push("approved plan is missing");
	if (input.unresolvedForks.length) blockers.push(`unresolved forks: ${input.unresolvedForks.join(", ")}`);
	const changes = previous
		? (["scopeBreadth", "risk", "reversible", "approvedPlan"] as const).flatMap(key => previous.record[key] === record[key] ? [] : [`${key} ${String(previous.record[key])} → ${String(record[key])}`])
		: [];
	const forkChange = previous && JSON.stringify(previous.record.unresolvedForks) !== JSON.stringify(record.unresolvedForks)
		? `unresolvedForks ${previous.record.unresolvedForks.join(", ") || "(none)"} → ${record.unresolvedForks.join(", ") || "(none)"}`
		: "";
	const reclassified = changes.length > 0 || !!forkChange;
	const reason = [
		blockers.length ? `planner required: ${blockers.join("; ")}` : "narrow reversible approved plan with no unresolved forks",
		input.selfDeclaredSmall ? "self-declared small was ignored" : "",
		reclassified ? `reclassified because ${[...changes, forkChange].filter(Boolean).join("; ")}` : "",
	].filter(Boolean).join(". ");
	return { route: blockers.length ? "planner-required" : "builder-reviewer", reason, reclassified, record };
}
