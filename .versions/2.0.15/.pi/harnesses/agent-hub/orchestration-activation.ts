import { buildEvidenceManifest } from "./evidence-manifest.ts";
import { selectSpecialists } from "./orchestration-route.ts";
import { recordRoutingObservation } from "./routing-observation.ts";
import { closeReview } from "./review-closure.ts";
import { chooseReviewerRerun } from "./rerun-policy.ts";

export function activeOrchestrationHandoff(input: {
	agent: string;
	task: string;
	scope: string[];
	revision: string;
	changes: string[];
	exitCode: number;
	command?: string;
	testsExecuted?: number;
	model?: string;
	elapsedMs?: number;
	questions: string[];
	evidenceRefs: string[];
	approvedPlan: boolean;
	risk: "low" | "high";
	scopeBreadth: "narrow" | "wide";
	sharedCode: boolean;
}) {
	const route = selectSpecialists({
		scopeBreadth: input.scopeBreadth,
		risk: input.risk,
		reversible: true,
		approvedPlan: input.approvedPlan,
		unresolvedForks: input.questions,
		selfDeclaredSmall: /small/i.test(input.task),
	}, { secret: /secret|credential/i.test(input.task), cloud: /\b(cloud|aws)\b/i.test(input.task) });
	const manifest = buildEvidenceManifest({
		revision: input.revision || "unknown",
		scope: input.scope,
		changes: input.changes,
		commands: input.command ? [{ command: input.command, exitCode: input.exitCode }] : [],
		tests: { executed: input.testsExecuted ?? 0, passed: 0, failed: 0 },
		evidenceRefs: input.evidenceRefs,
		openAssertions: input.questions,
		observedRevision: input.revision || "unknown",
	});
	const closure = closeReview({
		revision: input.revision || "unknown",
		scope: input.scope,
		prose: input.agent.includes("review") ? "PASS" : "",
		origin: input.evidenceRefs.length ? "declared" : "missing",
		structuredReturn: input.evidenceRefs.length ? { verdict: "PASS", evidenceRefs: input.evidenceRefs } : undefined,
	});
	const rerun = chooseReviewerRerun({
		impact: input.scopeBreadth === "wide" ? "wide" : "narrow",
		sharedCode: input.sharedCode,
		selector: input.scope[0] ?? "",
		flaky: false,
		policyMandate: false,
		builderPassed: input.exitCode === 0,
		reviewerRan: input.agent.includes("review"),
	});
	const observation = recordRoutingObservation({
		taskClass: route.stages.join("-"),
		model: input.model ?? "unknown",
		wallMs: input.elapsedMs ?? 0,
		retries: 0,
		refusals: 0,
		contractCompliant: closure.status !== "unproven",
		accepted: closure.status === "closed",
	});
	return { route, manifest, closure, rerun, observation, routingChanged: false as const };
}

const REVIEWERS = new Set(["code-reviewer", "plan-reviewer", "security-auditor"]);

export function plannerRequiredRefusal(task: string, agent: string, state?: { scope?: string; risk?: string; plan?: { evidenceRef?: string | null } }): string | null {
	if (agent === "planner" || REVIEWERS.has(agent)) return null;
	const secret = /secret|credential/i.test(task);
	const cloud = /\b(cloud|aws)\b/i.test(task);
	const approvedPlan = !!state?.plan?.evidenceRef;
	const highWithoutPlan = state?.risk === "high" && !approvedPlan;
	if (!secret && !cloud && !highWithoutPlan) return null;
	const decision = selectSpecialists({
		scopeBreadth: state?.scope === "wide" ? "wide" : "narrow",
		risk: state?.risk === "high" ? "high" : "low",
		reversible: true,
		approvedPlan,
		unresolvedForks: [],
		selfDeclaredSmall: state?.scope === "small" || /small/i.test(task),
	}, { secret, cloud });
	return decision.stages[0] === "planner" ? decision.reason : null;
}

export function reviewMayClose(input: { revision: string; scope: string[]; output: string; evidenceRef?: string; declared: boolean; wide: boolean }): boolean {
	const rerun = chooseReviewerRerun({
		impact: input.wide ? "wide" : "narrow",
		sharedCode: input.wide,
		selector: input.scope[0] ?? "",
		flaky: false,
		policyMandate: false,
		builderPassed: true,
		reviewerRan: true,
	});
	if (!rerun.accepted) return false;
	if (rerun.mode === "full" && !/full regression|tests_run:\s*full/i.test(input.output)) return false;
	return closeReview({
		revision: input.revision,
		scope: input.scope,
		prose: input.output,
		origin: input.declared ? "declared" : input.evidenceRef ? "extracted" : "missing",
		structuredReturn: /APPROVE/i.test(input.output) ? { verdict: "PASS", evidenceRefs: input.evidenceRef ? [input.evidenceRef] : [] } : undefined,
		evidenceComplete: !!input.evidenceRef,
		evidenceRevision: input.revision,
	}).status === "closed";
}
