// Plan PLAN-11-01 task 5: close on independent evidence for the integrated revision.
// Two editors contribute to one change through the normal guarded executor with
// stubbed dispatches. Each registered file carries who changed it; an author cannot
// approve its own work (including a coms peer session that changes role), a verdict
// on the base revision or on one editor's files cannot close the whole change, and a
// follow-up edit is reviewed as a delta against the previous findings.
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { comsRouteIdentity, createDispatchComs } from "./dispatch-coms.ts";
import { canonicalExecutor } from "./no-progress.ts";
import { applyProcessClassification, createProcessState, evaluateProcessObligations, latestProcessState, normalizeProcessState, processAuditRecord, processOpenObligations } from "./process-obligations.ts";
import { comsAuthor, nativeAuthor } from "./review-closure.ts";
import { worktreeRevision } from "./scope-gate.js";
import { createDispatchExecutor } from "./tools/dispatch-execution.ts";
import { assignmentFixture, nativeCleanLifecycle, settleTicks } from "./tools/dispatch-execution.test-support.ts";

const API = "src/api/index.ts", CLIENT = "src/client/index.ts";
const CHECK = "node --test integrated.test.js";
const APPROVE = "**Verdict:** APPROVE\nInspected the integrated change.";
const REJECT = "**Verdict:** REJECT\n### Critical\n- src/api/index.ts: the API change drops the input guard.";
const extensionContext = { ui: { notify() {} }, model: null } as any;
const details = (result: any) => result.details as Record<string, any>;
const text = (result: any) => String(result.content?.[0]?.text ?? "");

interface Call { agent: string; task: string; scope: string[] }
interface Step { output?: string; edit?: Record<string, string>; gate?: Promise<unknown>; coms?: { name: string; session_id: string }; checks?: boolean }

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** A coms route through the production dispatchViaComs: the peer does `work` while it holds the message. */
function comsRoute(peer: { name: string; session_id: string }, work: () => void, output: string, resolveTarget?: () => unknown) {
	let pending: any;
	return createDispatchComs({
		getIdentity: () => ({ session_id: "hub" }),
		resolveTarget: resolveTarget ?? (() => ({ name: peer.name, session_id: peer.session_id, model: "peer-model", context_used_pct: 0 })),
		send: async () => {
			work();
			pending = { promise: Promise.resolve({ response: output }), timer: null };
			return { msg_id: "msg", target: peer.name, target_session: peer.session_id, hops: 0, promise: pending.promise };
		},
		getPendingReply: () => pending, deletePendingReply: () => { pending = undefined; },
		getSessionDir: () => "/tmp", getWatchdogJudgeModel: () => null, getResearcherModel: () => null,
		displayName: (name: string) => name, safeAgentKey: (name: string) => name,
		safePathWithin: (root: string, ...parts: string[]) => [root, ...parts].join("/"),
		appendInputArtifacts: (task: string) => task, appendDeclaredScope: (task: string) => task,
		buildRulesProtocol: () => "", buildDocsProtocol: () => "", updateWidget() {},
		spawnPiAgent: async () => ({ output: "", exitCode: 0 }),
	} as any);
}

/**
 * The task 4 assignment fixture (git workspace, editor and read-only reviewer, writer
 * registry, instance cloning) with retained run artifacts, a high-risk task whose review
 * is required, one automated assertion, and a scripted stub per dispatch.
 */
async function independenceFixture(t: any) {
	const f = assignmentFixture(t);
	const sessionDir = f.d.state.getSessionDir();
	const { createAssertionsArtifactsContext } = await import("./context/assertions-artifacts.ts");
	const assertions = [{ id: "A1", tag: "test", text: "The integrated change passes its check", source: "fixture", testCommand: CHECK, status: "open" }];
	f.d.state.getAssertions = () => assertions as any;
	f.d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => assertions as any, getRunHistoryKeep: () => null, setStatus() {} }) as any;
	f.d.diagnoseChangedTypeScript = (async () => ({ status: "skipped", changedFiles: [], attribution: "no_observed_overlap", projects: [], uncoveredFiles: [] })) as any;
	let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "two editors change a shared interface" }).state;
	f.d.state.getProcessState = () => process;
	f.d.state.setProcessState = (value: any) => { process = value; };
	const fx = {
		...f, calls: [] as Call[], process: () => process, run: createDispatchExecutor(f.d as any),
		respond: (_call: Call): Step => ({}),
		dispatch: (id: string, params: Record<string, unknown>) => fx.run(id, params as any, undefined, undefined, f.ctx),
		native: (agent: string) => nativeAuthor(canonicalExecutor(f.cwd, agent)),
	};
	f.d.dispatchAgent = (async (agent: string, task: string, _ctx: unknown, _artifacts: unknown, scope: string[]) => {
		const state = f.agents.get(agent); state.status = "running";
		fx.calls.push({ agent, task, scope });
		const step = fx.respond({ agent, task, scope }); const dispatchId = `${agent}-run-${fx.calls.length}`;
		try {
			await step.gate;
			const work = () => { for (const [path, content] of Object.entries(step.edit ?? {})) writeFileSync(join(f.cwd, path), content); };
			if (step.coms) {
				const reply = await comsRoute(step.coms, work, step.output ?? "done").dispatchViaComs(state, task, step.coms.name, 5_000, false, extensionContext, [], scope);
				return { ...reply!, elapsed: 1, dispatchId };
			}
			state.lastBackend = "native";
			work();
			const revision = worktreeRevision(f.cwd, []);
			return { output: step.output ?? "done", exitCode: 0, elapsed: 1, dispatchId, lifecycle: nativeCleanLifecycle,
				...(step.checks ? { runtimeTests: [{ command: CHECK, exitCode: 0, beforeRevision: revision, afterRevision: revision }] } : {}) };
		} finally { state.status = "done"; }
	}) as any;
	return fx;
}

type Fixture = Awaited<ReturnType<typeof independenceFixture>>;

/** Two disjoint editors write concurrently (D12 instance editor--p2), each OS-isolated to its own scope. */
async function integrate(fx: Fixture) {
	const gates: Record<string, ReturnType<typeof deferred>> = { editor: deferred(), "editor--p2": deferred() };
	fx.respond = ({ agent }) => ({ gate: gates[agent]!.promise, edit: agent === "editor" ? { [API]: "export const api = 2;\n" } : { [CLIENT]: "export const client = 2;\n" } });
	const api = fx.dispatch("api", { agent: "editor", task: "Change the API to the agreed contract", scope: ["src/api"], parallel: true });
	const client = fx.dispatch("client", { agent: "editor", task: "Update the client to the agreed contract", scope: ["src/client"], parallel: true });
	await settleTicks(20);
	assert.deepEqual(fx.writers(), [{ agent: "editor", scope: ["src/api"], isolated: true }, { agent: "editor--p2", scope: ["src/client"], isolated: true }], "both editors write at once");
	gates.editor!.resolve(); gates["editor--p2"]!.resolve();
	const results = await Promise.all([api, client]);
	assert.deepEqual(results.map(result => details(result).agent), ["editor", "editor--p2"]);
	return results;
}

const wholeReview = { agent: "reviewer", task: "Review the integrated change", scope: ["src"] };

test("a coms route records its peer address and registry session; a re-registered peer leaves the session unknown", async () => {
	const peer = { name: "peer-a", session_id: "session-1" };
	const state: any = { def: { name: "editor" }, runCount: 1, contextPct: 0, lastWork: "" };
	assert.equal((await comsRoute(peer, () => {}, "done").dispatchViaComs(state, "task", "peer-a", 5_000, false, extensionContext, [], [])).exitCode, 0);
	assert.deepEqual(comsRouteIdentity(state), { address: "peer-a", sessionId: "session-1" });
	// The peer re-registered under another session while it held the message: either may have done the work.
	let lookups = 0;
	const moved = comsRoute(peer, () => {}, "done", () => ({ ...peer, session_id: lookups++ ? "session-2" : "session-1", model: "m", context_used_pct: 0 }));
	await moved.dispatchViaComs(state, "task", "peer-a", 5_000, false, extensionContext, [], []);
	assert.deepEqual(comsRouteIdentity(state), { address: "peer-a", sessionId: null });
	assert.equal(comsAuthor(comsRouteIdentity(state)), 'coms:["peer-a",null]');
	// A route that reaches no peer clears the previous identity instead of reusing it.
	assert.equal(await comsRoute(peer, () => {}, "done", () => null).dispatchViaComs(state, "task", "peer-a", 5_000, true, extensionContext, [], []), null);
	assert.equal(comsRouteIdentity(state), null);
});

test("two parallel editors register the union of changed files, each with its own author identity, and authorship survives persistence", async t => {
	const fx = await independenceFixture(t);
	await integrate(fx);
	assert.deepEqual(fx.process().changedFiles, [API, CLIENT]);
	assert.deepEqual(fx.process().changeAuthors, { [API]: [fx.native("editor")], [CLIENT]: [fx.native("editor--p2")] }, "one identity per assignment, bound to the workspace");
	const record = processAuditRecord(fx.process(), evaluateProcessObligations(fx.process(), { writable: true, budgetTier: "small" }));
	const restored = latestProcessState([{ type: "custom", customType: "agent-hub-process-state", data: JSON.parse(JSON.stringify(record)) }]);
	assert.deepEqual(restored.changeAuthors, fx.process().changeAuthors);
	const { changeAuthors: _authors, ...legacy } = fx.process();
	assert.equal(normalizeProcessState(legacy).changeAuthors, undefined, "a state saved before authorship stays valid");
	for (const corrupt of [{ [API]: ["somebody"] }, { [API]: [] }, [API], { [API]: "native:x" }])
		assert.throws(() => normalizeProcessState({ ...legacy, changeAuthors: corrupt }), /Invalid change authorship; dependent effects are blocked/);
});

test("(a) the coms peer session that edited cannot approve the change after changing role to reviewer; an independent reviewer can", async t => {
	const fx = await independenceFixture(t);
	const peer = { name: "peer-a", session_id: "session-1" };
	fx.respond = () => ({ edit: { [API]: "export const api = 2;\n" } });
	await fx.dispatch("api", { agent: "editor", task: "Change the API", scope: ["src/api"] });
	// Coms writes are never isolated, so the peer's assignment follows sequentially.
	fx.respond = () => ({ coms: peer, edit: { [CLIENT]: "export const client = 2;\n" } });
	const client = await fx.dispatch("client", { agent: "editor", task: "Update the client", scope: ["src/client"] });
	assert.equal(details(client).backendUsed, "coms");
	assert.deepEqual(comsRouteIdentity(fx.agents.get("editor")), { address: "peer-a", sessionId: "session-1" }, "the route records the peer address and registry session");
	const peerAuthor = comsAuthor({ address: "peer-a", sessionId: "session-1" });
	assert.deepEqual(fx.process().changeAuthors, { [API]: [fx.native("editor")], [CLIENT]: [peerAuthor] });

	fx.respond = () => ({ coms: peer, output: APPROVE });
	const self = await fx.dispatch("self-review", wholeReview);
	assert.equal(details(self).backendUsed, "coms");
	assert.equal(details(self).reviewEvidence.status, "preliminary");
	assert.deepEqual(details(self).reviewEvidence.reasons, ["review_self_authored"], "an approving verdict, refused only for authorship");
	assert.deepEqual(details(self).reviewEvidence.selfAuthored, { reviewer: peerAuthor, paths: [CLIENT] });
	assert.match(text(self), /Self-review refused \(review_self_authored\): reviewer ran as coms peer peer-a \(session session-1\), which authored src\/client\/index\.ts in this review's scope\./);
	assert.equal(details(self).accepted, false);
	assert.equal(details(self).processVerdict.obligations.review.status, "open");
	assert.equal(fx.process().review.evidenceRef, null);
	assert.equal(fx.process().reviews, undefined, "no reusable review evidence from an author");
	assert.equal(fx.process().reviewHistory, undefined, "nor review history");

	fx.respond = () => ({ output: APPROVE });
	const independent = await fx.dispatch("review", wholeReview);
	assert.equal(details(independent).reviewEvidence.status, "final", text(independent));
	assert.equal(details(independent).reviewEvidence.selfAuthored, undefined);
	assert.equal(fx.process().review.evidenceRef, details(independent).returnPath);
	assert.equal(fx.process().review.revision, worktreeRevision(fx.cwd, []));
	assert.equal(fx.process().reviews?.[0]?.executor, fx.native("reviewer"), "retained evidence names who reviewed");
});

test("(a) a native instance that changed a file in scope is refused as its reviewer as well", async t => {
	const fx = await independenceFixture(t);
	await integrate(fx);
	// A tracked active check (D4) by the reviewer rewrote a task file.
	fx.respond = () => ({ edit: { [API]: "export const api = 3;\n" } });
	const check = await fx.dispatch("checks", { agent: "reviewer", task: "Run the API checks", review_mode: "run-checks", backend: "native", scope: ["src"] });
	assert.ok(details(check).reviewEvidence.reasons.includes("review_self_authored"));
	assert.deepEqual(fx.process().changeAuthors![API], [fx.native("editor"), fx.native("reviewer")].sort());
	fx.respond = () => ({ output: APPROVE });
	const review = await fx.dispatch("review", wholeReview);
	assert.deepEqual(details(review).reviewEvidence.reasons, ["review_self_authored"]);
	assert.match(text(review), /reviewer ran as native instance reviewer, which authored src\/api\/index\.ts/);
	assert.equal(fx.process().review.evidenceRef, null);
});

test("(b) a verdict on the base revision cannot close the integrated change", async t => {
	const fx = await independenceFixture(t);
	const base = worktreeRevision(fx.cwd, []);
	const gates: Record<string, ReturnType<typeof deferred>> = { editor: deferred(), "editor--p2": deferred(), reviewer: deferred() };
	fx.respond = ({ agent }) => agent === "reviewer"
		? { gate: gates.reviewer!.promise, output: APPROVE }
		: { gate: gates[agent]!.promise, edit: { [agent === "editor" ? API : CLIENT]: `// changed by ${agent}\n` } };
	const api = fx.dispatch("api", { agent: "editor", task: "Change the API", scope: ["src/api"], parallel: true });
	const client = fx.dispatch("client", { agent: "editor", task: "Update the client", scope: ["src/client"], parallel: true });
	await settleTicks(20);
	const review = fx.dispatch("base-review", wholeReview);
	await settleTicks(20);
	assert.deepEqual(fx.calls.map(call => call.agent), ["editor", "editor--p2", "reviewer"], "the reviewer inspects while both editors still write");
	gates.editor!.resolve(); gates["editor--p2"]!.resolve(); await Promise.all([api, client]);
	gates.reviewer!.resolve();
	const verdict = details(await review).reviewEvidence;
	assert.equal(verdict.status, "preliminary");
	assert.equal(verdict.beforeRevision, base, "the reviewer started on the base revision");
	assert.equal(verdict.afterRevision, worktreeRevision(fx.cwd, []));
	assert.notEqual(verdict.afterRevision, base);
	for (const reason of ["writer_overlap", "revision_changed"]) assert.ok(verdict.reasons.includes(reason), `${reason} in ${verdict.reasons.join(", ")}`);
	assert.equal(fx.process().review.evidenceRef, null);
	assert.ok(processOpenObligations(fx.process(), worktreeRevision(fx.cwd, [])).includes("review"));
	// The same approval on the settled, integrated revision closes.
	fx.respond = () => ({ output: APPROVE });
	const settled = await fx.dispatch("settled-review", wholeReview);
	assert.equal(details(settled).reviewEvidence.status, "final", text(settled));
});

test("(c) a verdict covering one editor's files cannot close the multi-editor change, and two partial verdicts do not add up", async t => {
	const fx = await independenceFixture(t);
	await integrate(fx);
	fx.respond = () => ({ output: APPROVE });
	for (const [id, scope] of [["api-review", ["src/api"]], ["client-review", ["src/client"]]] as const) {
		const partial = await fx.dispatch(id, { agent: "reviewer", task: `Review ${scope[0]}`, scope: [...scope] });
		assert.equal(details(partial).reviewEvidence.status, "preliminary");
		assert.deepEqual(details(partial).reviewEvidence.reasons, ["incomplete_scope"], id);
		assert.equal(details(partial).reviewEvidence.scopeDiagnostic.omittedCount, 1);
		assert.equal(details(partial).processVerdict.obligations.review.status, "open");
		assert.equal(fx.process().review.evidenceRef, null, id);
	}
	const whole = await fx.dispatch("whole-review", wholeReview);
	assert.equal(details(whole).reviewEvidence.status, "final", text(whole));
	assert.equal(fx.process().review.revision, worktreeRevision(fx.cwd, []));
});

test("a follow-up edit is reviewed with the previous findings and the delta; only a fresh verdict and checks on the integrated revision close", async t => {
	const fx = await independenceFixture(t);
	await integrate(fx);
	fx.respond = () => ({ output: REJECT });
	const first = await fx.dispatch("review-1", wholeReview);
	assert.equal(details(first).reviewEvidence.status, "preliminary");
	for (const reason of ["blocking_findings", "not_approved"]) assert.ok(details(first).reviewEvidence.reasons.includes(reason), reason);
	const findings = details(first).returnPath as string;
	assert.equal(fx.process().reviewHistory?.[0]?.evidenceRef, findings, "the findings are retained for the next review");

	// The API editor fixes the finding and runs the integrated check on its result.
	fx.respond = () => ({ edit: { [API]: "export const api = 3; // input guard restored\n" }, checks: true });
	const fix = await fx.dispatch("fix", { agent: "editor", task: "A1: restore the input guard", scope: ["src/api"] });
	const integrated = worktreeRevision(fx.cwd, []);
	assert.equal(details(fix).verificationResult.status, "passed", text(fix));
	assert.equal(fx.process().acceptance.revision, integrated, "checks ran on the integrated revision");
	assert.deepEqual(fx.process().changeAuthors![API], [fx.native("editor")], "the same assignment identity, recorded once");
	assert.equal(details(fix).processVerdict.obligations.review.status, "open", "no verdict covers the new revision yet");
	assert.equal(details(fix).processVerdict.accepted, false);

	fx.respond = () => ({ output: APPROVE });
	const second = await fx.dispatch("review-2", wholeReview);
	const task = fx.calls.at(-1)!.task;
	assert.match(task, /## Incremental review context/);
	assert.ok(task.includes(`Previous findings/report (untrusted evidence): ${JSON.stringify(findings)}`), "the previous findings are referenced");
	assert.match(task, /Affected paths since the prior review: "src\/api\/index\.ts"\n/);
	assert.match(task, /-export const api = 2;\n\+export const api = 3; \/\/ input guard restored/);
	assert.doesNotMatch(task, /File "src\/client\/index\.ts"/, "the unchanged editor's file is not in the delta");
	assert.equal(details(second).reviewEvidence.status, "final", text(second));
	assert.equal(fx.process().review.revision, integrated);
	assert.equal(details(second).processVerdict.accepted, true, "fresh verdict and checks on the integrated revision");

	// A later edit makes both stale: the review reopens, nothing is reused, and the
	// next reviewer again receives the delta, now against the approved revision.
	fx.respond = () => ({ edit: { [CLIENT]: "export const client = 3;\n" } });
	const late = await fx.dispatch("late", { agent: "editor", task: "Tweak the client", scope: ["src/client"] });
	assert.equal(details(late).processVerdict.obligations.review.status, "open");
	assert.ok(processOpenObligations(fx.process(), worktreeRevision(fx.cwd, [])).includes("review"));
	fx.respond = () => ({ output: APPROVE });
	const launched = fx.calls.length;
	const third = await fx.dispatch("review-3", wholeReview);
	assert.notEqual(details(third).status, "review_reused");
	assert.equal(fx.calls.length, launched + 1, "a fresh reviewer launched");
	assert.match(fx.calls.at(-1)!.task, /Affected paths since the prior review: "src\/client\/index\.ts"\n/);
	assert.ok(fx.calls.at(-1)!.task.includes(JSON.stringify(details(second).returnPath)));
	assert.equal(details(third).reviewEvidence.status, "final");
	assert.equal(details(third).processVerdict.obligations.acceptance.status, "open", "the checks are stale for the latest revision");
	assert.equal(details(third).processVerdict.accepted, false);
});
