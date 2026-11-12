// Plan phase 7 acceptance (2026-11-12): the Hub end to end in a workspace shaped like
// rankedin, a plain folder holding the repositories rin-docs and ringithub. Every Hub
// module on the path is real: dispatch_agent (snapshots, change attribution, process
// stages, the no-progress guard), update_assertion's prove gate and /af-recover, wired
// the way index.ts wires them. Only the child agent is scripted: a native child reports
// the test it ran over the revision basis the Hub hands it (AGENT_FLEET_RUNTIME_TEST_SCOPES),
// and a coms peer returns a reply.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confirmRecoverAction } from "./budget-recovery.ts";
import { runRecoverCommand } from "./commands/recover.ts";
import { createAssertionsArtifactsContext } from "./context/assertions-artifacts.ts";
import { createNoProgressGuard } from "./no-progress.ts";
import { applyProcessClassification, createProcessState, nestedRepositoriesInUse } from "./process-obligations.ts";
import { revisionOf, revisionScopes, worktreeRevision } from "./scope-gate.js";
import { validateSpecialistResult } from "./specialist-result.ts";
import { createActionExecutors } from "./tools/action-executors.ts";
import { createDispatchExecutor } from "./tools/dispatch-execution.ts";

const TEST = "node --test prd.test.js";
const PASSED = "node --test prd.test.js → 3/3 pass";
/** What a launched native child that closed cleanly reports. */
const CLEAN = { launched: true, closeSeen: true, runtimeCaptureIntegrity: "complete" as const };

function repository(path: string, files: Record<string, string>) {
	mkdirSync(path);
	for (const [name, body] of Object.entries(files)) writeFileSync(join(path, name), body);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", ...args], { cwd: path, stdio: "ignore" });
	git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
}

/** One scripted child turn; `basis` is the revision basis the Hub passed to the child. */
type Child = (agent: string, basis: string[]) => Promise<Record<string, unknown>>;

function rankedin(t: any) {
	const root = mkdtempSync(join(tmpdir(), "af-rankedin-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionDir = mkdtempSync(join(tmpdir(), "af-rankedin-session-")); t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
	repository(join(root, "rin-docs"), { "prd.md": "# PRD\n", "guide.md": "# Guide\n" });
	repository(join(root, "ringithub"), { "app.ts": "export const app = 1;\n" });
	let assertions: any[] = [];
	let processState = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "rankedin PRD change" }).state;
	let turnDispatches = 0, taskDispatches = 0, reviewRounds = 0, activeWriters = 0, overlap = 0, calls = 0;
	const agents = new Map<string, any>([
		["builder", { def: { name: "builder", tools: "read,write,edit,bash" }, runCount: 0, contextPct: 0, lastBackend: null }],
		["code-reviewer", { def: { name: "code-reviewer", tools: "read,bash" }, runCount: 0, contextPct: 0, lastBackend: null }],
	]);
	const turnReport = { refusals: 0, dispatches: [] as unknown[], research: 0, tier: "small" };
	const sessionTotals = { refusals: 0, dispatches: 0, research: 0, billed: 0, out: 0 };
	const artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => assertions, getRunHistoryKeep: () => null, setStatus() {} });
	const noProgress = createNoProgressGuard();
	const children: Child[] = [];
	const ctx = { cwd: root, ui: { notify() {} } } as any;
	const execute = createDispatchExecutor({
		noProgress,
		state: {
			getTurnDispatchCount: () => turnDispatches, setTurnDispatchCount: (v: number) => { turnDispatches = v; },
			getTurnResearchCount: () => 0, setTurnResearchCount() {},
			getTaskDispatchCount: () => taskDispatches, setTaskDispatchCount: (v: number) => { taskDispatches = v; },
			getTaskResearchCount: () => 0, setTaskResearchCount() {},
			getTaskReviewRounds: () => reviewRounds, setTaskReviewRounds: (v: number) => { reviewRounds = v; },
			getTaskTier: () => "small",
			getProcessState: () => processState, setProcessState: (value: any) => { processState = value; }, persistProcessVerdict() {},
			getTurnReport: () => turnReport, getSessionTotals: () => sessionTotals,
			getTurnDispatchFingerprints: () => new Set<string>(),
			getExternalBlockers: () => [], getExternalBlockerAcknowledged: () => false, setExternalBlockerAcknowledged() {},
			getExternalBlockerRefusedOnce: () => false, setExternalBlockerRefusedOnce() {},
			isAskUserAvailable: () => true, getUserLanguage: () => "English",
			getSessionDir: () => sessionDir, getAgentStates: () => agents, getAssertions: () => assertions,
			getResearchPersonas: () => [],
			getActiveWritableDispatches: () => activeWriters, setActiveWritableDispatches: (v: number) => { activeWriters = v; },
			getWritableOverlapCounter: () => overlap, setWritableOverlapCounter: (v: number) => { overlap = v; },
		},
		budget: { ensureTaskTier() {}, taskCounters: () => ({ dispatches: taskDispatches, research: 0, reviewRounds }), taskActiveElapsedMs: () => 0, currentBudget: () => ({ agentTurnMs: 600_000, recycleRuns: 3, delegation: false }), updateModeStatus() {} },
		artifacts, research: {},
		provisionalCapabilityRefusal: () => null,
		dispatchAgent: async (agent: string, _task: string, _ctx: unknown, _inputs: unknown, _scope: string[], _watchdog: unknown, _backend: unknown, _resume: unknown, _contract: unknown, basis: string[] = []) => {
			const child = children.shift();
			if (!child) throw new Error(`no scripted child for ${agent}`);
			return child(agent, basis);
		},
		runReturnExtraction: async () => null, extractNeedsResearch: () => [], extractAskUserQuestions: () => [],
		contextPressure: () => false, displayName: (name: string) => name,
	} as any);
	// update_assertion with the ports index.ts gives it: the task revision for the record and
	// the revision over each stage's recorded basis for the prove gate (D8).
	const actions = createActionExecutors({
		budget: {} as any, artifacts, hubState: { getPendingHandoff: () => null, setPendingHandoff() {} } as any,
		provisionalCapabilityRefusal: () => null,
		getTaskTier: () => "small", setTaskTier() {}, getTaskTierAssumed: () => false, setTaskTierAssumed() {},
		getProcessState: () => processState, setProcessState: value => { processState = value; },
		getTaskDispatchCount: () => taskDispatches, getTaskResearchCount: () => 0, getTurnReport: () => turnReport as any,
		getAssertions: () => assertions, setAssertions: value => { assertions = value; },
		currentTaskId: () => noProgress.taskId(),
		currentRevision: c => { const cwd = c.cwd || process.cwd(); return revisionOf(cwd, revisionScopes(cwd, processState.changedFiles)); },
		revisionOf: (c, scopes) => revisionOf(c.cwd || process.cwd(), [...scopes]),
		getAgentStates: () => agents, rosterAdd: () => ({ ok: false, message: "" }), rosterDrop: () => ({ ok: false, message: "" }),
		getIdentity: () => null, getComs: () => null, resolveTarget: () => null, appendMachineHandoffSections: brief => brief, markPeerAddressed() {},
	});
	return {
		root, agents, noProgress,
		state: () => processState,
		assertion: (id: string) => assertions.find(item => item.id === id),
		/** Queue the child's next turn. */
		child: (next: Child) => { children.push(next); },
		pending: () => children.length,
		dispatch: async (params: Record<string, unknown>) => (await execute(`call-${++calls}`, params as any, undefined, undefined, ctx)) as any,
		setAssertions: (list: unknown[]) => actions.executeSetAssertions("set", { assertions: list } as any, undefined, undefined, ctx),
		prove: async (id: string, evidence = PASSED) => (await actions.executeUpdateAssertion("prove", { id, status: "proven", evidence } as any, undefined, undefined, ctx)) as any,
		/** /af-recover with the production ports; returns what it told the human. */
		recover: async (args: string) => {
			const notices: string[] = [];
			await runRecoverCommand(args, { cwd: root, ui: { notify: (text: string) => notices.push(text) } } as any, {
				noProgress, currentRevision: cwd => scopes => revisionOf(cwd, [...scopes]), confirm: confirmRecoverAction,
				askPorts: () => { throw new Error("this fixture never asks a human"); },
			});
			return notices;
		},
	};
}

type Rankedin = ReturnType<typeof rankedin>;

/** A native builder turn: edit, then run the declared test over the basis the Hub passed. */
function nativeBuilder(f: Rankedin, edit: () => void, testExit = 0, dispatchId = "build") {
	f.child(async (agent, basis) => {
		f.agents.get(agent).lastBackend = "native";
		edit();
		const revision = revisionOf(f.root, basis);
		return { output: testExit ? "The PRD test still fails." : "PRD updated; the PRD test passes.", exitCode: 0, elapsed: 1, dispatchId, lifecycle: CLEAN,
			runtimeTests: [{ command: TEST, exitCode: testExit, beforeRevision: revision, afterRevision: revision }] };
	});
}

/** A coms peer's reply, delivered through dispatch_agent. */
function comsReviewer(f: Rankedin, dispatchId: string, output = "verdict: APPROVE\nReviewed rin-docs/prd.md as it is now.\ntests_run: full regression") {
	f.child(async agent => { f.agents.get(agent).lastBackend = "coms"; return { output, exitCode: 0, elapsed: 1, dispatchId }; });
}

async function buildThenComsReview(f: Rankedin) {
	await f.setAssertions([
		{ id: "P1", tag: "test", text: "The PRD test passes", source: "user request", test_command: TEST },
		{ id: "P2", tag: "test", text: "The PRD test still passes after follow-up edits", source: "user request", test_command: TEST },
	]);
	nativeBuilder(f, () => writeFileSync(join(f.root, "rin-docs/prd.md"), "# PRD\n\nBuilt by the builder.\n"));
	const build = await f.dispatch({ agent: "builder", task: "P1 P2: update the PRD", scope: ["rin-docs/prd.md"] });
	assert.equal(build.details.backendUsed, "native");
	assert.deepEqual(f.state().changedFiles, ["rin-docs/prd.md"], "the builder's edit is attributed inside rin-docs");
	assert.deepEqual(f.state().acceptance.revisionScopes, ["rin-docs"]);
	const early = await f.prove("P1");
	assert.equal(early.details.reason, "process_obligations_open"); assert.match(early.content[0].text, /open: review/);
	comsReviewer(f, "coms-review-1");
	const review = await f.dispatch({ agent: "code-reviewer", task: "Review the P1 PRD change", scope: ["rin-docs/prd.md"], backend: "coms" });
	assert.equal(review.details.backendUsed, "coms");
	assert.equal(review.details.processVerdict.obligations.review.status, "satisfied", JSON.stringify(review.details.processVerdict));
	assert.deepEqual(f.state().review.revisionScopes, ["rin-docs"], "the review is recorded over the repository it covered");
	assert.deepEqual(nestedRepositoriesInUse(f.state()), ["rin-docs"], "the operator's capsule names only the repository in use");
	return review;
}

test("plan 7 e2e: the operator's own edit closes through a native current-state review and proves", async t => {
	const f = rankedin(t);
	assert.equal(worktreeRevision(f.root, []), "unavailable", "the workspace root itself has no revision");
	await f.setAssertions([{ id: "P1", tag: "test", text: "The PRD test passes", source: "user request", test_command: TEST }]);
	writeFileSync(join(f.root, "rin-docs/prd.md"), "# PRD\n\nEdited by the operator.\n");
	const early = await f.prove("P1");
	assert.equal(early.details.reason, "process_obligations_open"); assert.match(early.content[0].text, /open: review/);
	f.child(async (agent, basis) => {
		f.agents.get(agent).lastBackend = "native";
		const revision = revisionOf(f.root, basis);
		const submission = validateSpecialistResult({ status: "completed", summary: "Inspected the current PRD", changed_files: [], assertions_proven: [], assertions_unproven: [], assertions_failed: [], tests_run: ["full scoped regression"], open_risks: [], requires_user_decision: [], evidence: [] }, f.root);
		return { output: "**Verdict:** APPROVE\ntests_run: full regression", exitCode: 0, elapsed: 1, dispatchId: "current-state", lifecycle: CLEAN,
			specialistResultTool: true, specialistResult: submission, runtimeTests: [{ command: TEST, exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
	});
	const review = await f.dispatch({ agent: "code-reviewer", task: "P1: current state of the operator's PRD edit", scope: ["rin-docs/prd.md"], backend: "native", review_mode: "operator-current-state" });
	assert.equal(review.details.operatorStateVerification.status, "accepted", JSON.stringify(review.details.operatorStateVerification));
	assert.deepEqual(f.state().changedFiles, ["rin-docs/prd.md"]);
	assert.deepEqual(f.state().review.revisionScopes, ["rin-docs"]);
	const proof = await f.prove("P1");
	assert.equal(proof.details.status, "proven", JSON.stringify(proof.content));
	assert.equal(f.assertion("P1").status, "proven");
	assert.equal(f.assertion("P1").evidenceRevision, revisionOf(f.root, ["rin-docs"]), "the proof records the task revision over rin-docs");
});

test("plan 7 e2e: a builder change in rin-docs closes through a coms review via dispatch_agent and proves", async t => {
	const f = rankedin(t);
	await buildThenComsReview(f);
	const proof = await f.prove("P1");
	assert.equal(proof.details.status, "proven", JSON.stringify(proof.content));
	assert.equal(f.pending(), 0);
});

test("plan 7 e2e: a later change in rin-docs makes the review stale, a change in ringithub does not", async t => {
	const f = rankedin(t);
	await buildThenComsReview(f);
	writeFileSync(join(f.root, "ringithub/app.ts"), "export const app = 2;\n");
	const other = await f.prove("P1");
	assert.equal(other.details.status, "proven", `a change in another repository leaves the review current: ${other.content[0].text}`);
	writeFileSync(join(f.root, "rin-docs/guide.md"), "# Guide\n\nEdited after the review.\n");
	const stale = await f.prove("P2");
	assert.equal(stale.details.reason, "process_obligations_open", "any change in the reviewed repository makes the review stale (D8)");
	assert.match(stale.content[0].text, /open: review/); assert.equal(f.assertion("P2").status, "open");
	comsReviewer(f, "coms-review-2");
	const again = await f.dispatch({ agent: "code-reviewer", task: "Review the P2 PRD change again", scope: ["rin-docs/prd.md"], backend: "coms" });
	assert.equal(again.details.processVerdict.obligations.review.status, "satisfied");
	const proof = await f.prove("P2");
	assert.equal(proof.details.status, "proven", JSON.stringify(proof.content));
});

test("plan 7 e2e: /af-recover reconciles a failed builder attempt in rin-docs and releases the retry", async t => {
	const f = rankedin(t);
	await f.setAssertions([{ id: "P1", tag: "test", text: "The PRD test passes", source: "user request", test_command: TEST }]);
	const build = { agent: "builder", task: "P1: update the PRD", scope: ["rin-docs/prd.md"], deliverables: ["rin-docs/prd.md"] };
	nativeBuilder(f, () => writeFileSync(join(f.root, "rin-docs/prd.md"), "# PRD\n\nBuilt, but the test is red.\n"), 1, "build-red");
	const failed = await f.dispatch(build);
	assert.equal(failed.details.status, "verification_failed", JSON.stringify(failed.details.verificationResult));
	const refused = await f.dispatch(build);
	assert.equal(refused.details.status, "no_progress_refused", "an unchanged retry after a failed verification is fenced");
	const [, operationId, attemptId] = refused.content[0].text.match(/\/af-recover reconcile ([\w-]+) ([\w-]+)/) ?? [];
	assert.ok(operationId && attemptId, refused.content[0].text);
	const unreviewed = JSON.parse((await f.recover(`reconcile ${operationId} ${attemptId}`))[0]);
	assert.equal(unreviewed.cleared, false); assert.equal(unreviewed.reason, "independent_current_revision_review_required");
	const review = (dispatchId: string, output: string) => {
		f.child(async agent => { f.agents.get(agent).lastBackend = "native"; return { output, exitCode: 0, elapsed: 1, dispatchId }; });
		return f.dispatch({ agent: "code-reviewer", task: "Review the failed P1 PRD attempt", scope: ["rin-docs/prd.md"], backend: "native" });
	};
	await review("rejecting-review", "verdict: REJECT\nThe PRD edit drops the scope section.\n\n### Suggestions\n- Keep the scope section.\n");
	const rejected = JSON.parse((await f.recover(`reconcile ${operationId} ${attemptId}`))[0]);
	assert.equal(rejected.cleared, false, "a rejecting review is not a nonblocking review, whatever it lists");
	await review("independent-review", "verdict: APPROVE\nThe PRD edit is correct; only the test fixture is stale.\n");
	writeFileSync(join(f.root, "ringithub/app.ts"), "export const app = 2;\n");
	const cleared = JSON.parse((await f.recover(`reconcile ${operationId} ${attemptId}`))[0]);
	assert.equal(cleared.cleared, true, `a change in another repository does not stale the reconcile: ${JSON.stringify(cleared)}`);
	assert.deepEqual(cleared.provenScope, ["rin-docs/prd.md"]);
	nativeBuilder(f, () => writeFileSync(join(f.root, "rin-docs/prd.md"), "# PRD\n\nBuilt, and the test is green.\n"), 0, "build-green");
	const retried = await f.dispatch(build);
	assert.notEqual(retried.details.status, "no_progress_refused", "the cleared attempt releases the explicit retry");
	assert.equal(retried.details.verificationResult.status, "passed", JSON.stringify(retried.details.verificationResult));
	assert.equal(retried.details.processVerdict.obligations.review.status, "open", "reconcile clears only the technical block; the new change still needs its review");
	assert.equal(f.pending(), 0);
});
