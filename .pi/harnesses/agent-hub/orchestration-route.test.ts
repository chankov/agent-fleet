import assert from "node:assert/strict";
import test from "node:test";
import { authorizePlanStatusUpdate, classifyOrchestrationRoute, selectSpecialists, type RouteInputs } from "./orchestration-route.ts";

const narrow: RouteInputs = {
	scopeBreadth: "narrow",
	risk: "low",
	reversible: true,
	approvedPlan: true,
	unresolvedForks: [],
};

test("narrow planned fix can skip a new planner", () => {
	const decision = classifyOrchestrationRoute(narrow);
	assert.equal(decision.route, "builder-reviewer");
	assert.equal(decision.record.scopeBreadth, "narrow");
	assert.equal(decision.record.risk, "low");
	assert.equal(decision.record.reversible, true);
	assert.equal(decision.record.approvedPlan, true);
	assert.deepEqual(decision.record.unresolvedForks, []);
	assert.equal(decision.reclassified, false);
});

test("self-declared small is not enough", () => {
	const decision = classifyOrchestrationRoute({ ...narrow, approvedPlan: false, selfDeclaredSmall: true });
	assert.equal(decision.route, "planner-required");
	assert.match(decision.reason, /approved plan/i);
});

test("cross-cutting, secret, cloud, and a new fork require a planner", () => {
	for (const input of [
		{ ...narrow, scopeBreadth: "cross-cutting" as const },
		{ ...narrow, risk: "secret" as const },
		{ ...narrow, risk: "cloud" as const },
		{ ...narrow, unresolvedForks: ["adapter ownership"] },
	]) {
		assert.equal(classifyOrchestrationRoute(input).route, "planner-required");
	}
});

test("table-adapter fix skips planner and documenter", () => {
	const stages = selectSpecialists(narrow);
	assert.deepEqual(stages.stages, ["builder", "reviewer"]);
	assert.equal(stages.stages.includes("planner"), false);
	assert.equal(stages.stages.includes("documenter"), false);
});

test("wide or high-impact work still includes a planner", () => {
	assert.equal(selectSpecialists({ ...narrow, scopeBreadth: "wide" }).stages[0], "planner");
	assert.equal(selectSpecialists({ ...narrow, risk: "high" }).stages[0], "planner");
	assert.match(selectSpecialists({ ...narrow, risk: "low" }, { secret: true }).reason, /not lowered/);
});

test("builder updates plan status only inside scope with evidence", () => {
	assert.equal(authorizePlanStatusUpdate({ planPath: "docs/plans/adapter.md", allowedScope: ["docs/plans"], evidenceRefs: ["tests:69/69"] }).allowed, true);
	assert.equal(authorizePlanStatusUpdate({ planPath: "docs/plans/adapter.md", allowedScope: ["src"], evidenceRefs: ["tests:69/69"] }).allowed, false);
	assert.equal(authorizePlanStatusUpdate({ planPath: "docs/plans/adapter.md", allowedScope: ["docs/plans"], evidenceRefs: [] }).allowed, false);
});

test("scope or risk change reclassifies with a visible reason", () => {
	const previous = classifyOrchestrationRoute(narrow);
	const next = classifyOrchestrationRoute({ ...narrow, scopeBreadth: "wide", risk: "high" }, previous);
	assert.equal(next.reclassified, true);
	assert.equal(next.route, "planner-required");
	assert.match(next.reason, /scopeBreadth narrow → wide/);
	assert.match(next.reason, /risk low → high/);
});
