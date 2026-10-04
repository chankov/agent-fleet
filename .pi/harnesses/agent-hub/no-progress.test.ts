import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoProgressGuard, normalizeResearchContract, withNoProgress } from "./no-progress.ts";

function failed(id: string, category: any, reason = category) {
	return { dispatchId: id, reason, category };
}

test("production re-dispatch resumes only with a USER_ANSWER marker", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "user-answer-"));
	execFileSync("git", ["init", cwd], { stdio: "ignore" });
	writeFileSync(join(cwd, "a.ts"), "a");
	let calls = 0;
	const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
	const run = withNoProgress(d, "dispatch", async () => ({ content: [], details: { status: "blocked_on_user", recoveryCategory: "blocked_on_user", questions: ["Which file?"], exitCode: 0, dispatchId: `ask-${++calls}` } }), () => ({ model: "m" }));
	const base: any = { agent: "builder", task: "edit", scope: ["a.ts"] };
	await run("1", base, undefined, undefined, { cwd } as any);
	const prose = await run("2", { ...base, task: "just continue" }, undefined, undefined, { cwd } as any);
	assert.equal((prose.details as any).status, "no_progress_refused");
	assert.equal(calls, 1);
	const resumed = await run("3", { ...base, task: "USER_ANSWER: ask-1 :: Which file?" }, undefined, undefined, { cwd } as any);
	assert.equal((resumed.details as any).status, "blocked_on_user");
	assert.equal(calls, 2);
});

test("a recorded user answer resumes the same blocked task once", () => {
	const guard = createNoProgressGuard();
	const scope = ["src/adapter.ts"];
	const first = guard.begin("edit", "model-a", "builder", scope);
	guard.finish(first, "model-a", failed("ask-1", "blocked_on_user"));
	assert.equal(guard.begin("edit", "model-b", "builder", scope).allowed, false, "unanswered");
	assert.equal(guard.recordUserAnswer({ dispatchId: "ask-1", question: "Which file?", scope, prose: "just do it" }), true);
	assert.equal(guard.begin("edit", "model-b", "builder", ["src", "secret.env"]).allowed, false, "changed scope");
	const resumed = guard.begin("edit", "model-b", "builder", scope);
	assert.equal(resumed.allowed, true, "answered");
	guard.finish(resumed, "model-b", failed("ask-1b", "blocked_on_user"));
	assert.equal(guard.begin("edit", "model-c", "builder", scope).allowed, false, "reused answer does not cover the next block");
	const stale = guard.begin("stale", "model-a", "builder", scope);
	guard.finish(stale, "model-a", failed("ask-3", "blocked_on_user"));
	guard.recordUserAnswer({ dispatchId: "ask-3", question: "Still?", scope });
	guard.adopt("other-task");
	assert.equal(guard.begin("stale", "model-a", "builder", scope).allowed, false, "stale task");
	const cancelled = guard.begin("cancel", "model-a", "builder", scope);
	guard.finish(cancelled, "model-a", failed("ask-4", "blocked_on_user"));
	guard.recordUserAnswer({ dispatchId: "ask-4", question: "Cancel?", scope });
	assert.equal(guard.cancelUserAnswer("ask-4"), true);
	assert.equal(guard.begin("cancel", "model-a", "builder", scope).allowed, false, "cancellation");
	assert.deepEqual(guard.userAnswerCapabilities(), { filesystem: false, network: false, cloud: false, secrets: false });
});

test("operator cancellation requires fresh one-use authorization; model or fingerprint changes cannot bypass it", () => {
	const guard = createNoProgressGuard();
	const first = guard.begin("operation", "model-a");
	guard.finish(first, "model-a", failed("cancel-1", "operator_cancelled"));
	assert.equal(guard.begin("operation", "model-b").allowed, false, "changed effective model is not cancellation authorization");
	assert.equal(guard.authorize("cancel-1"), true);
	assert.equal(guard.authorize("cancel-1"), false, "authorization is one-use and cannot be duplicated");
	const authorized = guard.begin("operation", "model-b");
	assert.equal(authorized.allowed, true);
	guard.finish(authorized, "model-b", failed("cancel-2", "operator_cancelled"));
	assert.equal(guard.begin("operation", "model-c").allowed, false, "the next cancellation needs a fresh authorization");
	assert.equal(guard.authorize("cancel-1"), false, "old completion cannot authorize the new cancellation");
});

test("evidenced changes permit supported recovery, while indeterminate cause never authorizes retry", () => {
	const guard = createNoProgressGuard();
	const verification = guard.begin("verify", "rev-a");
	guard.finish(verification, "rev-a", failed("verify-1", "verification_failed"));
	assert.equal(guard.begin("verify", "rev-a").allowed, false);
	assert.equal(guard.begin("verify", "rev-b").allowed, true);

	const unknown = guard.begin("unknown", "rev-a");
	guard.finish(unknown, "rev-a", failed("unknown-1", "indeterminate"));
	assert.equal(guard.authorize("unknown-1"), false);
	assert.equal(guard.begin("unknown", "rev-b").allowed, false, "unknown cause stays fail-closed despite changed conditions");
});

test("a no-launch refusal does not replace an indeterminate fence, including after task reset and restore", () => {
	const entries: any[] = [];
	const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
	const first = guard.begin("contract", "fp", "exec");
	guard.finish(first, "fp", failed("ind-1", "indeterminate"));
	assert.equal(guard.settle(first.operationId!, first.attemptId!, "proc-close"), true);
	assert.equal(guard.authorizeIndeterminate(first.operationId!, first.attemptId!, "nonce"), true);
	const retry = guard.begin("contract", "fp-changed", "exec");
	assert.equal(retry.allowed, true);
	guard.finish(retry, "fp-changed", failed("pre-1", "not_started"));
	assert.equal(guard.begin("contract", "fp-again", "exec").allowed, false, "same task must not launch after the no-launch retry");
	guard.reset();
	assert.equal(guard.begin("contract", "fp-new-task", "exec").allowed, false, "task reset must not drop the unknown-write fence");
	const restored = createNoProgressGuard();
	restored.restore(entries);
	assert.equal(restored.begin("contract", "fp-restored", "exec").allowed, false, "restart must keep the effect fence");
});

test('one settled indeterminate grant enables only one explicit next attempt, including after task reset', () => {
 const g = createNoProgressGuard(); const first = g.begin('contract', 'same', 'builder');
 g.finish(first, 'same', failed('ind-1', 'indeterminate'));
 assert.equal(g.begin('contract', 'changed', 'builder').allowed, false);
 assert.equal(g.authorizeIndeterminate(first.operationId!, first.attemptId!, 'nonce'), false, 'unsettled process refuses');
 assert.equal(g.settle(first.operationId!, first.attemptId!, 'trusted-process-exit'), true);
 g.reset();
 assert.equal(g.authorizeIndeterminate(first.operationId!, first.attemptId!, 'human-nonce'), true);
 assert.equal(g.authorizeIndeterminate(first.operationId!, first.attemptId!, 'second'), false);
 const second = g.begin('contract', 'same', 'builder'); assert.equal(second.allowed, true);
 g.finish(second, 'same', failed('ind-2', 'indeterminate'));
 assert.equal(g.begin('contract', 'changed', 'builder').allowed, false);
 assert.equal(g.settle(second.operationId!, second.attemptId!, 'exit-2'), true);
 assert.equal(g.authorizeIndeterminate(second.operationId!, second.attemptId!, 'second-human'), false);
});

test("busy is an immediate refusal and does not poison completion or unrelated work", () => {
	const guard = createNoProgressGuard();
	const active = guard.begin("same", "rev");
	const busy = guard.begin("same", "rev");
	assert.equal(busy.allowed, false); assert.equal(busy.refusal, "busy");
	assert.equal(guard.begin("unrelated", "rev").allowed, true);
	guard.finish(busy, "rev", failed("must-not-record", "indeterminate"));
	guard.finish(active, "rev");
	assert.equal(guard.begin("same", "rev").allowed, true, "a busy refusal records no failure");
});

test("stale completion after task reset cannot consume or grant authorization", () => {
	const guard = createNoProgressGuard(); const oldTaskId = guard.taskId();
	const stale = guard.begin("operation", "old");
	guard.reset(); assert.notEqual(guard.taskId(), oldTaskId, "new-task reset rotates runtime task identity");
	guard.finish(stale, "old", failed("stale-cancel", "operator_cancelled"));
	assert.equal(guard.authorize("stale-cancel"), false);
	assert.equal(guard.begin("operation", "old").allowed, false, "reset cannot manufacture settled-process proof or replay a live attempt");
});

test("structured research contract normalizes paths and prose without changing legacy calls", () => {
	assert.deepEqual(normalizeResearchContract({ read_scope: ["./src/", "src", " docs\\plan.md "], goal: "  find   facts ", expected_result: " lines  " }), {
		readScope: ["docs/plan.md", "src"], goal: "find facts", expectedResult: "lines",
	});
	assert.deepEqual(normalizeResearchContract({}), { readScope: [], goal: undefined, expectedResult: undefined });
});

test("research progress ignores paraphrase but recognizes a normalized read-scope change and effective model", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "research-progress-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", cwd], { stdio: "ignore" }); writeFileSync(join(cwd, "source.ts"), "same");
	let calls = 0; let model = "local/a";
	const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
	const run = withNoProgress(d, "research", async () => ({ content: [], details: { status: "verification_failed", exitCode: 1, dispatchId: `r-${++calls}` } }), () => ({ model, tools: "read,grep,find,ls" }));
	const base: any = { task: "original wording", read_scope: ["src/**"], goal: "locate API", expected_result: "path:line" };
	await run("1", base, undefined, undefined, { cwd } as any);
	const paraphrase = await run("2", { ...base, task: "completely rephrased", goal: "locate   API" }, undefined, undefined, { cwd } as any);
	assert.equal((paraphrase.details as any).status, "no_progress_refused"); assert.equal(calls, 1);
	await run("3", { ...base, read_scope: ["src/narrow/**"] }, undefined, undefined, { cwd } as any);
	assert.equal(calls, 2, "a real structured scope change is a distinct bounded operation");
	model = "local/b";
	await run("4", base, undefined, undefined, { cwd } as any);
	assert.equal(calls, 3, "effective model is part of execution conditions");
});

test("integer exit without explicit lifecycle does not settle; closeSeen does", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "lifecycle-settle-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", cwd]); writeFileSync(join(cwd, "src.ts"), "one");
	const unsettled = createNoProgressGuard();
	const unsetRun = withNoProgress({ noProgress: unsettled, artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => ({ content: [], details: { status: "error", exitCode: 1, dispatchId: "exit-only" } }));
	await unsetRun("1", { agent: "builder", task: "work", scope: ["src.ts"], deliverables: [] } as any, undefined, undefined, { cwd } as any);
	assert.equal(unsettled.byDispatch("exit-only")?.attempts.at(-1)?.settled, undefined);
	const settled = createNoProgressGuard();
	const settledRun = withNoProgress({ noProgress: settled, artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => ({ content: [], details: { status: "error", exitCode: 1, dispatchId: "closed", lifecycle: { launched: true, closeSeen: true } } }));
	await settledRun("1", { agent: "builder", task: "work", scope: ["src.ts"], deliverables: [] } as any, undefined, undefined, { cwd } as any);
	assert.match(String(settled.byDispatch("closed")?.attempts.at(-1)?.settled), /^runtime-lifecycle:/);
});

test('production tool refusal offers validated recover commands and stored original-contract invocation without replay', async t => {
 const cwd=mkdtempSync(join(tmpdir(),'recover-refusal-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync('git',['init','-q',cwd]); writeFileSync(join(cwd,'src.ts'),'one');
 const guard=createNoProgressGuard(), d:any={noProgress:guard,artifacts:{loadInputArtifacts:()=>[]}};
 let calls=0;
 const run=withNoProgress(d,'dispatch',async()=>{calls++;return {content:[],details:{status:'indeterminate',dispatchId:'physical-1',exitCode:1,reason:'lost'}}},()=>({model:'m'}));
 const params:any={agent:'builder',task:'continue exactly this work',scope:['src.ts'],deliverables:['src.ts']};
 await run('one',params,undefined,undefined,{cwd} as any);
 const refused=await run('two',params,undefined,undefined,{cwd} as any);
 assert.equal((refused.details as any).status,'no_progress_refused');
 const op=guard.byDispatch('physical-1')!, attempt=op.attempts[0];
 assert.match((refused.content[0] as any).text,new RegExp(`/af-recover retry ${op.operationId} ${attempt.attemptId}`));
 assert.match((refused.content[0] as any).text, /dispatch_agent\(\{"agent":"builder","task":"continue exactly this work"/);
 assert.equal(calls,1);
});

test("dispatch triage metadata survives persistence without authorizing a retry", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "triage-contract-"));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync("git", ["init", "-q", cwd]);
 const guard = createNoProgressGuard();
 let calls = 0;
 const run = withNoProgress({ noProgress: guard, artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => {
  calls++;
  return { content: [], details: { status: "indeterminate", dispatchId: "triage-physical", exitCode: 1, reason: "lost" } };
 });
 const params = { agent: "builder", task: "inspect", triage_id: "evaluation-1", triage_reason: "independent_judgment" as const };
 await run("one", params, undefined, undefined, { cwd } as any);
 assert.equal(calls, 1);
 const operation = guard.byDispatch("triage-physical")!;
 assert.deepEqual(guard.invocation(operation.operationId), { tool: "dispatch_agent", params });
 const refused = await run("two", { ...params, triage_id: "evaluation-2", triage_reason: "used" }, undefined, undefined, { cwd } as any);
 assert.equal((refused.details as any).status, "no_progress_refused");
 assert.equal(calls, 1, "advisory metadata cannot authorize retry");
});

test("dispatch persistence rejects unknown keys and invalid triage metadata before launch", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "invalid-triage-contract-"));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync("git", ["init", "-q", cwd]);
 for (const extra of [{ unexpected: "value" }, { triage_id: 123 }, { triage_reason: "authorize" }, { triage_reason: false }]) {
  let calls = 0;
  const run = withNoProgress({ noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => { calls++; return { content: [] }; });
  const result = await run("one", { agent: "builder", task: "inspect", ...extra } as any, undefined, undefined, { cwd } as any);
  assert.equal((result.details as any).reason, "invalid_invocation_shape");
  assert.equal(calls, 0);
 }
});

test("scope_mode, prose and disjoint scope do not bypass same-agent cancellation", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "dispatch-cancel-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", cwd], { stdio: "ignore" }); writeFileSync(join(cwd, "a.ts"), "a"); writeFileSync(join(cwd, "b.ts"), "b");
	let calls = 0;
	const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
	const run = withNoProgress(d, "dispatch", async () => ({ content: [], details: { status: "cancelled", reason: "cancelled", exitCode: 1, dispatchId: `d-${++calls}` } }), () => ({ model: "m" }));
	const base: any = { agent: "builder", task: "first wording", scope: ["a.ts"], scope_mode: "existing" };
	await run("1", base, undefined, undefined, { cwd } as any);
	const blocked = await run("2", { ...base, task: "new prose", scope_mode: "create" }, undefined, undefined, { cwd } as any);
	assert.equal((blocked.details as any).recoveryCategory, "operator_cancelled"); assert.equal(calls, 1);
	await run("3", { ...base, task: "unrelated", scope: ["b.ts"] }, undefined, undefined, { cwd } as any);
	assert.equal(calls, 1, "advisory scope cannot bypass the agent fence");
});

for (const kind of ["dispatch", "research"] as const) test(`${kind}: cancellation survives scope widening, narrowing, and omitted scope`, async () => {
 let calls = 0;
 const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
 const run = withNoProgress(d, kind, async () => ({ content: [], details: { status: "cancelled", exitCode: 1, dispatchId: `cancel-${++calls}` } }));
 const field = kind === "dispatch" ? "scope" : "read_scope";
 const base: any = { task: "work", ...(kind === "dispatch" ? { agent: "builder" } : {}), [field]: ["src/**"] };
 await run("1", base, undefined, undefined, {} as any);
 for (const scope of [["src/**", "docs/**"], ["src/a.ts"], ["src//a.ts"], ["."], []]) {
  const refused = await run("2", { ...base, [field]: scope }, undefined, undefined, {} as any);
  assert.equal((refused.details as any).recoveryCategory, "operator_cancelled");
 }
 assert.equal(calls, 1);
 assert.equal(d.noProgress.authorize("cancel-1"), true);
 await run("3", { ...base, [field]: ["src/**", "docs/**"] }, undefined, undefined, {} as any);
 assert.equal(calls, 2);
});

test("result-enriched execution conditions do not fabricate relevant changes", async t => {
 // Use a private worktree: other test files can change the checkout while
 // Node runs them concurrently, which is genuine progress to this guard.
 const cwd = mkdtempSync(join(tmpdir(), "result-enriched-progress-"));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync("git", ["init", "-q", cwd]);
 let calls = 0;
 const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
 const run = withNoProgress(d, "dispatch", async () => ({ content: [], details: { status: "verification_failed", exitCode: 0, dispatchId: `v-${++calls}` } }), (_p, _c, result) => ({ model: result ? "actual/model" : "configured/model", backend: result ? "native" : "auto" }));
 const params = { agent: "builder", task: "work" };
 await run("1", params, undefined, undefined, { cwd } as any);
 const result = await run("2", params, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).status, "no_progress_refused"); assert.equal(calls, 1);
});

test("research scope is repository-relative advisory input, not an escaping path", () => {
 for (const path of ["/etc", "../src", "src/../../etc", "C:\\secret"]) assert.throws(() => normalizeResearchContract({ read_scope: [path] }), /relative|escape/i);
});

test("cancellation fences agent identity across disjoint contracts and leaves other running agents intact", () => {
 const g = createNoProgressGuard();
 const other = g.begin("other", "r", "reviewer");
 const first = g.begin("original", "r", "builder", ["src/a"]);
 g.finish(first, "r", failed("cancel", "operator_cancelled"));
 for (const scope of [["docs/throwaway"], ["src", "docs"], []]) assert.equal(g.begin(JSON.stringify(scope), "new-model-and-prose", "builder", scope).allowed, false);
 g.finish(other, "r");
 assert.equal(g.begin("other", "r", "reviewer").allowed, true);
 assert.equal(g.authorize("cancel"), true);
 const retry = g.begin("disjoint", "new", "builder", ["docs"]);
 assert.equal(retry.allowed, true);
 assert.equal(g.authorize("cancel"), false);
 g.finish(retry, "new", failed("cancel2", "operator_cancelled"));
 assert.equal(g.begin("original", "r", "builder").allowed, false);
});

test("trusted effects-established recovery is task-bound and never authorizes cancellation", () => {
 const g = createNoProgressGuard(); const token = g.taskToken();
 const first = g.begin("protocol", "before"); g.finish(first, "before", failed("p1", "tool_protocol_error"));
 assert.equal(g.begin("protocol", "corrected").allowed, false);
 assert.equal(g.establishEffects("p1", token, ""), false);
 assert.equal(g.establishEffects("p1", token, "/e/effects.json"), true);
 assert.equal(g.begin("protocol", "before").allowed, false);
 assert.equal(g.begin("protocol", "corrected").allowed, true);
 const cancelled = g.begin("cancel", "r"); g.finish(cancelled, "r", failed("c1", "operator_cancelled"));
 assert.equal(g.establishEffects("c1", token, "/e/effects.json"), false);
 g.reset(); assert.equal(g.establishEffects("p1", token, "/e/effects.json"), false);
});

test("real unknown-tool dispatch failures bind the runtime catalog producer to shared T1 recovery", async () => {
 const g = createNoProgressGuard(); let calls = 0;
 const d: any = {
  noProgress: g, artifacts: { loadInputArtifacts: () => [] },
  getToolCatalogVersion: () => "trusted-cat-v1",
 };
 const run = withNoProgress(d, "dispatch", async () => ({
  content: [],
  details: { status: "unknown_tool", recoveryCategory: "unknown_tool", exitCode: 1, dispatchId: `u${++calls}`, catalogVersion: "model-fake" },
 }), () => ({ conditions: "unchanged" }));
 const params: any = { agent: "builder", task: "use an unavailable tool" };
 await run("1", params, undefined, undefined, {} as any);
 assert.equal((await run("2", params, undefined, undefined, {} as any).then(result => (result.details as any).status)), "no_progress_refused");
 assert.equal(g.establishToolStateChange("model-fake", "trusted-cat-v2", "/e/fake.json"), 0, "model result cannot manufacture catalog evidence");
 assert.equal(g.establishToolStateChange("trusted-cat-v1", "trusted-cat-v2", "session-entry:agent-hub-tool-catalog-state:trusted-cat-v2"), 1);
 assert.equal((await run("3", params, undefined, undefined, {} as any).then(result => (result.details as any).status)), "unknown_tool");
 assert.equal(calls, 2, "recovery only permits the explicit post-change invocation; it never auto-retries");
});

test("same persona cancellation also fences research vs dispatch operations", async () => {
 const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } }; let runs = 0;
 const execute = async () => { runs++; return { content: [], details: { status: "cancelled", exitCode: 1, dispatchId: "cross-mode" } }; };
 const dispatch = withNoProgress(d, "dispatch", execute), research = withNoProgress(d, "research", execute);
 await dispatch("d", { agent: "deep-researcher", task: "work" }, undefined, undefined, {} as any);
 const result = await research("r", { persona: "Deep_Researcher", task: "other", read_scope: ["docs"] }, undefined, undefined, {} as any);
 assert.equal((result.details as any).status, "no_progress_refused"); assert.equal(runs, 1);
});

test("task reset does not silently authorize a recorded operator cancellation", () => {
 const g = createNoProgressGuard(); const first = g.begin("work", "r", "builder");
 g.finish(first, "r", failed("cancel-persistent", "operator_cancelled"));
 g.reset(); assert.equal(g.begin("new-task", "new", "builder").allowed, false);
 assert.equal(g.authorize("cancel-persistent"), true);
 assert.equal(g.begin("new-task", "new", "builder").allowed, true);
});

test('production restore refuses a conflicting checkpoint without reopening a consumed indeterminate grant', () => {
 const entries: any[] = [];
 const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 const first = guard.begin('contract', 'same', 'builder');
 guard.finish(first, 'same', failed('indeterminate-1', 'indeterminate'));
 assert.equal(guard.settle(first.operationId!, first.attemptId!, 'runtime-exit'), true);
 assert.equal(guard.authorizeIndeterminate(first.operationId!, first.attemptId!, 'nonce-1'), true);
 const preGrant = entries.filter(row => row.data.kind !== 'ledger' || row.data.event.type !== 'grant').map(row => row.data);
 const conflicting = [...entries, { customType: 'agent-hub-recover-event', data: { kind: 'snapshot', rows: preGrant } }];
 guard.prepareSessionRestore();
 assert.throws(() => guard.restore(conflicting), /invalid recovery snapshot/i);
 assert.equal(guard.inspect(first.operationId!)?.indeterminateGrantUsed, true);
 assert.equal(guard.authorizeIndeterminate(first.operationId!, first.attemptId!, 'nonce-2'), false);
 const resumed = createNoProgressGuard();
 assert.throws(() => resumed.restore(conflicting), /invalid recovery snapshot/i);
 guard.compact(entries);
 resumed.restore([entries.at(-1)]);
 assert.equal(resumed.authorizeIndeterminate(first.operationId!, first.attemptId!, 'nonce-2'), false);
});

test('first pre-model task identity survives compaction and resume without a dispatch or reset', () => {
 const entries: any[] = [];
 const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 const original = guard.taskId();
 guard.persistTaskIdentity(); guard.persistTaskIdentity();
 assert.equal(entries.filter(row => row.data.kind === 'guard' && row.data.event.type === 'task').length, 1);
 guard.compact(entries);
 const resumed = createNoProgressGuard();
 resumed.restore(entries);
 assert.equal(resumed.taskId(), original);
 resumed.persistTaskIdentity();
 resumed.reset(false); // a genuine new task is still a separate identity
 assert.notEqual(resumed.taskId(), original);
});

test('legacy assessment identity restores only with no conflicting recovery history', () => {
 const initial = createNoProgressGuard();
 initial.restore([], 'saved-task');
 assert.equal(initial.taskId(), 'saved-task');
 const entries: any[] = [];
 const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 guard.persistTaskIdentity();
 const resumed = createNoProgressGuard();
 resumed.restore(entries, 'different-process-task');
 assert.equal(resumed.taskId(), guard.taskId(), 'an explicit persisted task wins over a stale fallback');
});

test('failed guard replay does not replace the current cancellation fence', () => {
 const entries: any[] = [], guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 const first = guard.begin('work', 'same', 'builder');
 guard.finish(first, 'same', failed('cancel-1', 'operator_cancelled'));
 guard.prepareSessionRestore();
 assert.throws(() => guard.restore([...entries, { customType: 'agent-hub-recover-event', data: { kind: 'guard', event: { type: 'authorize', key: 'wrong', dispatchId: 'cancel-1' } } }]), /invalid recovery guard history/i);
 assert.equal(guard.begin('other', 'different', 'builder').allowed, false);
 assert.equal(guard.authorize('cancel-1'), true);
});
