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
	route: "builder-reviewer";
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
	const decision = classifyOrchestrationRoute(input);
	const clarification = signals.contradiction || input.unresolvedForks.length > 0;
	return { stages: ["builder", "reviewer"] as const, reason: [decision.reason,
		clarification ? "Resolve gaps with focused research; use ask_user grilling for additional decisions." : "",
		signals.secret || signals.cloud ? "Sensitive-action authorization and independent review remain separate." : "",
	].filter(Boolean).join(" ") };
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
	const changes = previous
		? (["scopeBreadth", "risk", "reversible", "approvedPlan"] as const).flatMap(key => previous.record[key] === record[key] ? [] : [`${key} ${String(previous.record[key])} → ${String(record[key])}`])
		: [];
	const forkChange = previous && JSON.stringify(previous.record.unresolvedForks) !== JSON.stringify(record.unresolvedForks)
		? `unresolvedForks ${previous.record.unresolvedForks.join(", ") || "(none)"} → ${record.unresolvedForks.join(", ") || "(none)"}`
		: "";
	const reclassified = changes.length > 0 || !!forkChange;
	const reason = [
		"Execute the authorized task; Planner and plan review are optional, never admission prerequisites",
		input.selfDeclaredSmall ? "self-declared small was ignored" : "",
		reclassified ? `reclassified because ${[...changes, forkChange].filter(Boolean).join("; ")}` : "",
	].filter(Boolean).join(". ");
	return { route: "builder-reviewer", reason, reclassified, record };
}
