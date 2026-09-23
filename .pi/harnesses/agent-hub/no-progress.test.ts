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

test("result-enriched execution conditions do not fabricate relevant changes", async () => {
 let calls = 0;
 const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
 const run = withNoProgress(d, "dispatch", async () => ({ content: [], details: { status: "verification_failed", exitCode: 0, dispatchId: `v-${++calls}` } }), (_p, _c, result) => ({ model: result ? "actual/model" : "configured/model", backend: result ? "native" : "auto" }));
 const params = { agent: "builder", task: "work" };
 await run("1", params, undefined, undefined, {} as any);
 const result = await run("2", params, undefined, undefined, {} as any);
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

test('failed guard replay does not replace the current cancellation fence', () => {
 const entries: any[] = [], guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 const first = guard.begin('work', 'same', 'builder');
 guard.finish(first, 'same', failed('cancel-1', 'operator_cancelled'));
 guard.prepareSessionRestore();
 assert.throws(() => guard.restore([...entries, { customType: 'agent-hub-recover-event', data: { kind: 'guard', event: { type: 'authorize', key: 'wrong', dispatchId: 'cancel-1' } } }]), /invalid recovery guard history/i);
 assert.equal(guard.begin('other', 'different', 'builder').allowed, false);
 assert.equal(guard.authorize('cancel-1'), true);
});
