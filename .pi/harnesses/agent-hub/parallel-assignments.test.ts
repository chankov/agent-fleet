// Plan PLAN-11-01 task 4: independent assignments through the normal guarded
// dispatch executor. Repeated role names stay independently addressable (D12) and a
// consumer waits for, or is refused because of, the instances it names in `after` (D13).
import assert from "node:assert/strict";
import test from "node:test";
import { assignmentOutcome, createDispatchExecutor } from "./tools/dispatch-execution.ts";
import { assignmentFixture, settleTicks } from "./tools/dispatch-execution.test-support.ts";

const details = (result: any) => result.details as Record<string, any>;
const text = (result: any) => String(result.content?.[0]?.text ?? "");

test("two reviewers on different concerns run concurrently; the second is reviewer--p2 without parallel: true", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const security = run("security", { agent: "reviewer", task: "Review src/api for injection", scope: ["src/api"] }, undefined, undefined, f.ctx);
	const docs = run("docs", { agent: "reviewer", task: "Review src/client error messages", scope: ["src/client"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.deepEqual(f.runs.map(r => r.agent), ["reviewer", "reviewer--p2"], "both inspections started before either settled");
	assert.deepEqual(f.created, ["reviewer--p2"]);
	assert.deepEqual(f.writers(), [], "inspection takes no writer slot");
	assert.ok(f.runs.every(r => r.access.writable === false && r.access.activeCheck !== true), "both launches keep the read-only ceiling");
	assert.match(f.runs[1]!.task, /client error messages/);
	f.runs[1]!.settle(); f.runs[0]!.settle();
	const [first, second] = [await security, await docs];
	assert.equal(details(first).agent, "reviewer"); assert.equal(details(first).instance, undefined);
	assert.equal(details(second).agent, "reviewer--p2");
	assert.equal(details(second).instance, "reviewer--p2"); assert.equal(details(second).requestedAgent, "reviewer");
	assert.match(text(second), /^ℹ Ran as reviewer--p2 \(reviewer was busy\)/);
	assert.equal(details(first).dispatchId, "reviewer-run-1"); assert.equal(details(second).dispatchId, "reviewer--p2-run-2", "each result carries its own run");
	assert.equal(f.d._turn(), 2);
});

test("a reviewer active check is not cloned automatically: a busy base still refuses it", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const inspection = run("inspect", { agent: "reviewer", task: "Review src/api", scope: ["src/api"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const checks = await run("checks", { agent: "reviewer", task: "Run the API checks", review_mode: "run-checks", backend: "native" }, undefined, undefined, f.ctx);
	assert.equal(details(checks).status, "busy"); assert.equal(details(checks).started, false);
	assert.deepEqual(f.created, [], "an active check keeps the explicit parallel rule");
	assert.equal(f.runs.length, 1);
	f.runs[0]!.settle(); await inspection;
});

test("two disjoint editors with parallel: true run concurrently, each isolated to its own scope", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	const client = run("client", { agent: "editor", task: "Update the client to the agreed contract", scope: ["src/client"], parallel: true }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.deepEqual(f.runs.map(r => [r.agent, r.scope]), [["editor", ["src/api"]], ["editor--p2", ["src/client"]]]);
	assert.deepEqual(f.writers(), [{ agent: "editor", scope: ["src/api"], isolated: true }, { agent: "editor--p2", scope: ["src/client"], isolated: true }]);
	f.runs[0]!.settle(0, "src/api/index.ts"); f.runs[1]!.settle(0, "src/client/index.ts");
	const [a, b] = [await api, await client];
	assert.equal(details(a).agent, "editor"); assert.equal(details(b).agent, "editor--p2"); assert.equal(details(b).instance, "editor--p2");
	assert.equal(details(a).executionStatus, "completed"); assert.equal(details(b).executionStatus, "completed");
	assert.deepEqual(f.writers(), [], "both writer slots are released");
});

test("overlapping writers are refused before start, and an unflagged second writer stays sequential", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const overlap = await run("overlap", { agent: "editor", task: "Tweak the API index", scope: ["src/api/index.ts"], parallel: true }, undefined, undefined, f.ctx);
	assert.equal(details(overlap).status, "scope_overlap"); assert.equal(details(overlap).started, false);
	assert.match(text(overlap), /editor's running write scope \(src\/api\/index\.ts ↔ src\/api\)/);
	const unflagged = await run("unflagged", { agent: "editor", task: "Update the client", scope: ["src/client"] }, undefined, undefined, f.ctx);
	assert.equal(details(unflagged).status, "busy", "without parallel: true the second write waits for the first");
	assert.equal(details(unflagged).started, false);
	assert.equal(f.runs.length, 1, "neither refused writer launched");
	assert.equal(f.d._turn(), 1, "refusals charge nothing");
	f.runs[0]!.settle(0, "src/api/index.ts"); await api;
});

test("a mixed group: an isolated editor writes while two reviewers inspect, and checks wait for the writer", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const writer = run("write", { agent: "editor", task: "Implement the API change", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	const base = run("base", { agent: "reviewer", task: "Inspect the named base revision of src/client", scope: ["src/client"] }, undefined, undefined, f.ctx);
	const edge = run("edge", { agent: "reviewer", task: "Check edge cases in src/client parsing", scope: ["src/client"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.deepEqual(f.runs.map(r => r.agent), ["editor", "reviewer", "reviewer--p2"], "read-only work stays available alongside the writer");
	assert.deepEqual(f.writers().map(w => w.agent), ["editor"], "only the editor holds a writer slot");
	f.runs[2]!.settle(); assert.equal(details(await edge).agent, "reviewer--p2");
	// Checks read a tree the writer may still change, so they keep the sequential slot.
	const checks = await run("checks", { agent: "reviewer--p2", task: "Run the client checks", review_mode: "run-checks", backend: "native" }, undefined, undefined, f.ctx);
	assert.equal(details(checks).status, "writer_active"); assert.equal(details(checks).started, false);
	assert.equal(f.runs.length, 3);
	f.runs[0]!.settle(0, "src/api/index.ts"); f.runs[1]!.settle();
	const results = await Promise.all([writer, base]);
	assert.deepEqual(results.map(r => details(r).agent), ["editor", "reviewer"]);
	const sequential = run("checks-2", { agent: "reviewer--p2", task: "Run the client checks", review_mode: "run-checks", backend: "native" }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.equal(f.runs.at(-1)!.agent, "reviewer--p2", "once the writer settled the check takes the sequential slot");
	assert.equal(f.runs.at(-1)!.access.activeCheck, true);
	f.runs.at(-1)!.settle(); await sequential;
});

test("a consumer with after waits for an unsettled dependency, then proceeds after it succeeds", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	const client = run("client", { agent: "editor", task: "Update the client", scope: ["src/client"], parallel: true }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const updates: any[] = [];
	const review = run("review", { agent: "reviewer", task: "Review the integrated change", scope: ["src"], after: ["editor", "Editor--p2"] }, undefined, update => updates.push(update), f.ctx);
	await settleTicks(20);
	assert.equal(f.runs.length, 2, "the consumer has not started");
	assert.equal(f.d._turn(), 2, "and is not charged while queued");
	assert.equal(updates.length, 1);
	assert.equal(updates[0].details.status, "queued"); assert.deepEqual(updates[0].details.waitingFor, ["editor", "editor--p2"]);
	assert.match(updates[0].content[0].text, /^reviewer queued after editor, editor--p2/);
	f.runs[0]!.settle(0, "src/api/index.ts"); await api; await settleTicks(10);
	assert.equal(f.runs.length, 2, "one dependency is still running");
	assert.match(updates.at(-1).content[0].text, /queued after editor--p2;/, "the visible status follows the remaining dependency");
	f.runs[1]!.settle(0, "src/client/index.ts"); await client; await settleTicks(20);
	assert.deepEqual(f.runs.map(r => r.agent), ["editor", "editor--p2", "reviewer"]);
	f.runs[2]!.settle();
	const result = await review;
	assert.equal(details(result).agent, "reviewer"); assert.equal(details(result).executionStatus, "completed");
	assert.equal(f.d._turn(), 3);
});

test("a consumer is refused, nothing started, when its dependency's run failed", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const review = run("review", { agent: "reviewer", task: "Review the API change", scope: ["src/api"], after: ["editor"] }, undefined, undefined, f.ctx);
	await settleTicks(10);
	f.runs[0]!.settle(1); await api;
	const refused = await review;
	assert.equal(details(refused).status, "dependency_failed"); assert.equal(details(refused).started, false); assert.equal(details(refused).effects, "none");
	assert.equal(details(refused).dependency, "editor");
	assert.match(text(refused), /^Dependency editor failed: status \S+, exit 1.*\(dispatch editor-run-1\); re-dispatch it or drop it from after\. Nothing started or charged\./);
	assert.equal(f.runs.length, 1); assert.equal(f.d._turn(), 1);
});

test("among several dependencies the refusal names the instance that failed", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	const client = run("client", { agent: "editor", task: "Update the client", scope: ["src/client"], parallel: true }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const review = run("review", { agent: "reviewer", task: "Review the integrated change", after: ["editor", "editor--p2"] }, undefined, undefined, f.ctx);
	await settleTicks(10);
	f.runs[1]!.settle(1); await client; await settleTicks(10);
	assert.equal(f.runs.length, 2, "still waiting: editor runs, so the failure is not reported early");
	f.runs[0]!.settle(0, "src/api/index.ts"); await api;
	const refused = await review;
	assert.equal(details(refused).dependency, "editor--p2");
	assert.match(text(refused), /^Dependency editor--p2 failed: .*\(dispatch editor--p2-run-2\)/);
	assert.equal(f.runs.length, 2);
});

test("a consumer cancelled while queued is refused before dispatch and nothing starts", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const controller = new AbortController();
	const review = run("review", { agent: "reviewer", task: "Review the API change", after: ["editor"] }, controller.signal, undefined, f.ctx);
	await settleTicks(10);
	controller.abort();
	const cancelled = await review;
	assert.equal(details(cancelled).status, "cancelled"); assert.equal(details(cancelled).recoveryCategory, "operator_cancelled");
	assert.equal(details(cancelled).started, false);
	assert.match(text(cancelled), /^Operation cancelled before dispatch while queued after editor\. Nothing started or charged\./);
	assert.equal(f.runs.length, 1, "the dependency keeps running; the consumer never launched");
	assert.equal(f.d._turn(), 1);
	f.runs[0]!.settle(0, "src/api/index.ts"); await api;
	const fresh = run("review-2", { agent: "reviewer", task: "Review the API change", after: ["editor"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.equal(f.runs.at(-1)!.agent, "reviewer", "the cancellation left no fence on a later explicit dispatch");
	f.runs.at(-1)!.settle(); await fresh;
});

test("after names are validated before anything waits: unknown, research, wrong shape and a cycle", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const cases: Array<[unknown, string, RegExp]> = [
		[["editor--p3"], "after_unknown", /unknown instance editor--p3\. Known instances: editor, reviewer\./],
		[["researcher"], "after_unknown", /spawn_research handles/],
		["editor", "after_invalid", /array of agent keys/],
		[[" "], "after_invalid", /array of agent keys/],
	];
	for (const [after, reason, message] of cases) {
		const result = await run("bad", { agent: "reviewer", task: "Review", after } as any, undefined, undefined, f.ctx);
		assert.equal(details(result).status, "invalid_input", reason); assert.equal(details(result).reason, reason);
		assert.equal(details(result).recoveryCategory, "invalid_input"); assert.equal(details(result).started, false);
		assert.match(text(result), message);
	}
	const never = await run("never", { agent: "reviewer", task: "Review", after: ["editor"] }, undefined, undefined, f.ctx);
	assert.equal(details(never).reason, "dependency_no_result");
	assert.match(text(never), /^No settled result for editor in this task; dispatch it first, or drop it from after\./);
	// A cycle among queued assignments would wait forever; it is refused instead.
	const api = run("api", { agent: "editor", task: "Implement", scope: ["src/api"], parallel: true }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const review = run("review", { agent: "reviewer", task: "Review", after: ["editor"] }, undefined, undefined, f.ctx);
	await settleTicks(5);
	const cycle = await run("cycle", { agent: "editor", task: "Follow the review", scope: ["src/client"], parallel: true, after: ["reviewer"] }, undefined, undefined, f.ctx);
	assert.equal(details(cycle).reason, "after_cycle"); assert.match(text(cycle), /reviewer is already queued after editor/);
	assert.equal(f.runs.length, 1); assert.equal(f.d._turn(), 1, "no refused or queued call is charged");
	f.runs[0]!.settle(0, "src/api/index.ts"); await api; await settleTicks(20);
	f.runs.at(-1)!.settle(); await review;
});

test("a second assignment of the same role waits for the first; same-role dependents queue in order, never on themselves", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	// One editor produces the contract; the next editor assignment consumes it once the first has settled.
	const producer = run("contract", { agent: "editor", task: "Define the export contract", scope: ["src/api"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	const updates: any[] = [];
	const consumer = run("consumer", { agent: "editor", task: "Use the contract", scope: ["src/client"], after: ["editor"] }, undefined, update => updates.push(update), f.ctx);
	const second = run("second", { agent: "editor", task: "Document the contract", scope: ["docs"], after: ["editor"] }, undefined, undefined, f.ctx);
	await settleTicks(20);
	assert.equal(f.runs.length, 1, "both dependents are queued, none started");
	assert.equal(updates[0].details.status, "queued");
	assert.match(updates[0].content[0].text, /^editor queued after editor; nothing started or charged yet\./);
	f.runs[0]!.settle(0, "src/api/index.ts"); await producer; await settleTicks(20);
	assert.equal(f.runs.length, 2, "the first dependent starts; the second waits behind it, not on itself");
	f.runs[1]!.settle(0, "src/client/index.ts"); assert.equal(details(await consumer).executionStatus, "completed");
	await settleTicks(20);
	assert.equal(f.runs.length, 3, "then the second dependent runs");
	f.runs[2]!.settle(0, "docs/index.md"); assert.equal(details(await second).executionStatus, "completed");
	assert.deepEqual(f.runs.map(r => r.agent), ["editor", "editor", "editor"]);
	assert.equal(f.d._turn(), 3, "each charged once, when it started");
});

test("a dependency's outcome counts only in the task it ran in", async t => {
	const f = assignmentFixture(t); const run = createDispatchExecutor(f.d as any);
	const api = run("api", { agent: "editor", task: "Implement the API change", scope: ["src/api"] }, undefined, undefined, f.ctx);
	await settleTicks(20); f.runs[0]!.settle(0, "src/api/index.ts"); await api;
	f.d.noProgress.reset(false);
	const result = await run("review", { agent: "reviewer", task: "Review the API change", after: ["editor"] }, undefined, undefined, f.ctx);
	assert.equal(details(result).reason, "dependency_no_result");
});

test("assignment outcomes: refusals leave no record; completion, acceptance and reuse succeed; unfinished work fails", () => {
	assert.equal(assignmentOutcome({ content: [], details: { status: "busy", started: false } } as any), null);
	assert.equal(assignmentOutcome({ content: [], details: { status: "scope_overlap", started: false, notStarted: true } } as any), null);
	assert.equal(assignmentOutcome({ content: [], details: { status: "no_progress_refused", exitCode: 1 } } as any), null);
	assert.equal(assignmentOutcome({ content: [], details: { status: "review_reused", started: false, exitCode: 0 } } as any)?.state, "succeeded");
	for (const status of ["accepted", "completed_unverified"]) assert.equal(assignmentOutcome({ content: [], details: { status, executionStatus: "completed", exitCode: 0, specialistCompletion: "completed" } } as any)?.state, "succeeded", status);
	for (const status of ["verification_failed", "blocked_on_user", "tool_protocol_error"]) assert.equal(assignmentOutcome({ content: [], details: { status, executionStatus: "completed", exitCode: 0 } } as any)?.state, "failed", status);
	assert.equal(assignmentOutcome({ content: [], details: { status: "completed_unverified", executionStatus: "completed", exitCode: 0, specialistCompletion: "partial" } } as any)?.reason, "the specialist reported partial");
	assert.equal(assignmentOutcome({ content: [], details: { status: "pending", pending: true, exitCode: 0 } } as any)?.state, "pending");
	assert.equal(assignmentOutcome({ content: [], details: { status: "error", exitCode: 1 } } as any)?.state, "failed");
	assert.equal(assignmentOutcome(undefined)?.state, "failed");
});
