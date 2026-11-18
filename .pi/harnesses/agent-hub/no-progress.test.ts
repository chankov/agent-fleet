import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalExecutor, createNoProgressGuard, normalizeResearchContract, processRecoveryAttempts, RECOVER_ENTRY, withNoProgress } from "./no-progress.ts";
import { runRecoverCommand } from "./commands/recover.ts";

function failed(id: string, category: any, reason = category) {
	return { dispatchId: id, reason, category };
}

test("restoring an orphaned start releases the executor but fences the original contract with its real dispatch", () => {
	const entries: any[] = [];
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const original = createNoProgressGuard(persist);
	const ticket = original.begin("orphan-contract", "before-crash", "builder", ["src.ts"]);
	const dispatchId = original.inspect(ticket.operationId!)!.attempts[0].dispatchId;
	const restored = createNoProgressGuard(persist);
	restored.restore(entries);
	const attempt = restored.inspect(ticket.operationId!)!.attempts[0];
	assert.equal(attempt.category, "indeterminate");
	assert.equal(attempt.completed, undefined);
	assert.equal(attempt.settled, undefined, "a dead owner is not process-settlement evidence");
	assert.equal(restored.canAuthorize(ticket.operationId!, ticket.attemptId!), false);
	const refused = restored.begin("orphan-contract", "changed", "builder", ["src.ts"]);
	assert.equal(refused.allowed, false);
	assert.equal(refused.failure?.category, "indeterminate");
	assert.equal(refused.failure?.dispatchId, dispatchId);
	const other = restored.begin("other-contract", "changed", "builder", ["other.ts"]);
	assert.equal(other.allowed, true, "the orphan must not reserve the executor for unrelated contracts");
	restored.finish(other, "changed");
	assert.ok(entries.some(row => row.customType === RECOVER_ENTRY && row.data.kind === "ledger" && row.data.event.type === "failure" && row.data.event.operationId === ticket.operationId && row.data.event.attemptId === ticket.attemptId && row.data.event.category === "indeterminate"));
	assert.ok(entries.some(row => row.customType === RECOVER_ENTRY && row.data.kind === "guard" && row.data.event.type === "failure" && row.data.event.failure.dispatchId === dispatchId && row.data.event.failure.category === "indeterminate"));
	const beforeReplay = structuredClone(entries);
	const again = createNoProgressGuard(persist);
	assert.doesNotThrow(() => again.restore(entries));
	assert.deepEqual(entries, beforeReplay, "a second restore must append neither a duplicate ledger failure nor a duplicate guard failure");
	assert.equal(again.begin("orphan-contract", "changed-again", "builder").failure?.dispatchId, dispatchId);
});

test("restoring an orphaned cancellation retry supersedes its earlier unconsumed authorization", () => {
	const entries: any[] = [];
	let interruptConsume = false;
	const guard = createNoProgressGuard((type, data: any) => {
		if (interruptConsume && data.kind === "guard" && data.event.type === "consume") throw new Error("interrupted before consuming cancellation authorization");
		entries.push({ customType: type, data });
	});
	const first = guard.begin("contract", "before", "builder");
	guard.finish(first, "before", failed("cancelled-dispatch", "operator_cancelled"));
	assert.equal(guard.authorize("cancelled-dispatch"), true);
	interruptConsume = true;
	assert.throws(() => guard.begin("contract", "retry", "builder"), /interrupted/);
	const starts = entries.filter(row => row.data.kind === "ledger" && row.data.event.type === "start");
	const orphan = starts.at(-1).data.event;
	assert.equal(starts.length, 2, "the next attempt was durably started before the consume append failed");
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const restored = createNoProgressGuard(persist);
	restored.restore(entries);
	const refused = restored.begin("contract", "changed-again", "builder");
	assert.equal(refused.allowed, false, "the old cancellation authorization must not replay the new indeterminate attempt");
	assert.equal(refused.failure?.category, "indeterminate");
	assert.equal(refused.failure?.dispatchId, orphan.dispatchId);
	const other = restored.begin("other-contract", "revision", "builder");
	assert.equal(other.allowed, true, "the superseded cancellation must not fence unrelated contracts");
	restored.finish(other, "revision");
	const replay = createNoProgressGuard(persist);
	const beforeReplay = structuredClone(entries);
	replay.restore(entries);
	assert.deepEqual(entries, beforeReplay);
	assert.equal(replay.begin("contract", "another-change", "builder").failure?.category, "indeterminate");
});

test("restored orphan on another contract consumes the executor's superseded cancellation authorization", () => {
	const entries: any[] = [];
	let interruptConsume = false;
	const guard = createNoProgressGuard((type, data: any) => {
		if (interruptConsume && data.kind === "guard" && data.event.type === "consume") throw new Error("interrupted cancellation consume");
		entries.push({ customType: type, data });
	});
	const first = guard.begin("cancelled-contract", "before", "builder");
	guard.finish(first, "before", failed("cancelled-dispatch", "operator_cancelled"));
	assert.equal(guard.authorize("cancelled-dispatch"), true);
	interruptConsume = true;
	assert.throws(() => guard.begin("orphan-contract", "revision", "builder"), /interrupted cancellation consume/);
	const orphan = entries.filter(row => row.data.kind === "ledger" && row.data.event.type === "start").at(-1).data.event;
	assert.notEqual(orphan.operationId, first.operationId);
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const restored = createNoProgressGuard(persist);
	restored.restore(entries);
	const refused = restored.begin("orphan-contract", "changed", "builder");
	assert.equal(refused.allowed, false, "a different contract's old cancellation authorization must not override this orphan's indeterminate fence");
	assert.equal(refused.failure?.category, "indeterminate");
	assert.equal(refused.failure?.dispatchId, orphan.dispatchId);
	const other = restored.begin("unrelated-contract", "revision", "builder");
	assert.equal(other.allowed, true, "the superseded cancellation must release the executor for other contracts");
	restored.finish(other, "revision");
	const replay = createNoProgressGuard(persist);
	const beforeReplay = structuredClone(entries);
	replay.restore(entries);
	assert.deepEqual(entries, beforeReplay, "cancellation repair and orphan closure must remain idempotent");
	assert.equal(replay.begin("orphan-contract", "changed-again", "builder").failure?.dispatchId, orphan.dispatchId);
	const next = replay.begin("another-contract", "revision", "builder");
	assert.equal(next.allowed, true);
	replay.finish(next, "revision");
});

test("restore repairs a closing ledger failure whose matching guard append was interrupted", () => {
	const entries: any[] = [];
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const original = createNoProgressGuard(persist);
	const first = original.begin("orphan-contract", "revision", "builder");
	const dispatchId = original.inspect(first.operationId!)!.attempts[0].dispatchId;
	const interrupted = createNoProgressGuard((type, data: any) => {
		if (data.kind === "guard" && data.event.type === "failure") throw new Error("interrupted guard append");
		persist(type, data);
	});
	assert.throws(() => interrupted.restore(entries), /interrupted guard append/);
	assert.equal(entries.filter(row => row.data.kind === "ledger" && row.data.event.type === "failure").length, 1);
	assert.equal(entries.filter(row => row.data.kind === "guard" && row.data.event.type === "failure").length, 0);
	const restored = createNoProgressGuard(persist);
	restored.restore(entries);
	const guardFailures = entries.filter(row => row.data.kind === "guard" && row.data.event.type === "failure");
	assert.equal(guardFailures.length, 1, "replay must durably repair the interrupted guard failure append");
	assert.equal(guardFailures[0].data.event.failure.dispatchId, dispatchId);
	assert.equal(guardFailures[0].data.event.failure.category, "indeterminate");
	assert.ok(guardFailures[0].data.event.fingerprint, "the repair must remain valid guard history on replay");
	assert.equal(restored.begin("orphan-contract", "changed", "builder").allowed, false);
	const beforeReplay = structuredClone(entries);
	const again = createNoProgressGuard(persist);
	assert.doesNotThrow(() => again.restore(entries));
	assert.deepEqual(entries, beforeReplay, "repair must not append a duplicate ledger or guard failure");
	assert.equal(again.begin("orphan-contract", "changed-again", "builder").failure?.dispatchId, dispatchId);
});

test("failed restore persistence blocks dispatch across task reset until durable history is restored", () => {
	const entries: any[] = [];
	const original = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
	const first = original.begin("orphan-contract", "revision", "builder");
	let storageUnavailable = true;
	const guard = createNoProgressGuard((type, data: any) => {
		if (storageUnavailable && data.kind === "guard" && data.event.type === "failure") throw new Error("storage unavailable");
		entries.push({ customType: type, data });
	});
	assert.throws(() => guard.restore(entries), /storage unavailable/);
	assert.equal(guard.begin("orphan-contract", "changed", "builder").allowed, false, "failed restore must not expose the initially empty guard as a fresh contract");
	guard.reset();
	assert.equal(guard.begin("other-contract", "changed", "builder").allowed, false, "reset must not bypass failed-restore fencing");
	storageUnavailable = false;
	assert.doesNotThrow(() => guard.restore(entries));
	assert.equal(guard.inspect(first.operationId!)!.attempts[0].category, "indeterminate");
	assert.equal(guard.begin("orphan-contract", "changed-again", "builder").failure?.category, "indeterminate");
	const other = guard.begin("other-contract", "changed", "builder");
	assert.equal(other.allowed, true, "a successful reload clears the temporary storage fence");
	guard.finish(other, "changed");
});

test("restore refuses while this process owns an attempt and preserves its completion callback", () => {
	const entries: any[] = [];
	const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
	const ticket = guard.begin("live-contract", "revision", "builder");
	const beforeRestore = structuredClone(entries);
	assert.throws(() => guard.restore(entries), /live|running|owned|in.flight|pending/i);
	assert.deepEqual(entries, beforeRestore, "a live attempt must not be closed or persisted as failed");
	assert.equal(guard.inspect(ticket.operationId!)!.attempts[0].category, undefined);
	assert.equal(guard.begin("other-contract", "revision", "builder").refusal, "busy");
	guard.finish(ticket, "revision");
	assert.equal(guard.inspect(ticket.operationId!)!.attempts[0].completed, true);
	assert.doesNotThrow(() => guard.restore(entries));
});

test("task reset cannot hide current-process ownership from restore", () => {
	const entries: any[] = [];
	const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
	const ticket = guard.begin("live-contract", "revision", "builder");
	guard.reset();
	const beforeRestore = structuredClone(entries);
	assert.throws(() => guard.restore(entries), /live|running|owned|in.flight|pending/i);
	assert.deepEqual(entries, beforeRestore);
	guard.finish(ticket, "revision");
	assert.doesNotThrow(() => guard.restore(entries), "the stale callback must still release runtime ownership");
	assert.equal(guard.inspect(ticket.operationId!)!.attempts[0].category, "indeterminate", "restore may close the old attempt only after its owner callback returns");
});

test("extension reload cannot close an attempt owned by the previous guard in this process", async t => {
	const entries: any[] = [];
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const owners = processRecoveryAttempts();
	const original = createNoProgressGuard(persist, owners);
	const ticket = original.begin("live-contract", "revision", "builder");
	t.after(() => owners.delete(ticket.id));
	const moduleAfterReload = await import(`${new URL('./no-progress.ts', import.meta.url)}?reload-test`);
	assert.equal(moduleAfterReload.processRecoveryAttempts(), owners);
	const reloaded = moduleAfterReload.createNoProgressGuard(persist, moduleAfterReload.processRecoveryAttempts());
	const beforeRestore = structuredClone(entries);
	assert.throws(() => reloaded.restore(entries), /live|running|owned|in.flight|pending/i);
	assert.deepEqual(entries, beforeRestore);
	assert.equal(reloaded.begin("other-contract", "revision", "builder").allowed, false, "the host can swallow a session_start error, so the new guard must stay fenced");
	original.finish(ticket, "revision");
	assert.doesNotThrow(() => reloaded.restore(entries));
	assert.equal(reloaded.inspect(ticket.operationId!)!.attempts[0].completed, true);
	const other = reloaded.begin("other-contract", "revision", "builder");
	assert.equal(other.allowed, true);
	reloaded.finish(other, "revision");
});

test("restored orphan refusal renders only ledger identities and never launches a retry", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "orphan-refusal-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", cwd]);
	const entries: any[] = [];
	const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
	const original = createNoProgressGuard(persist);
	const key = JSON.stringify(["dispatch", cwd, "builder", ["src.ts"], [], ["src.ts"]]);
	const ticket = original.begin(key, "revision", canonicalExecutor(cwd, "builder"), ["src.ts"]);
	const params = { agent: "builder", task: "original task", scope: ["src.ts"], deliverables: ["src.ts"] };
	assert.equal(original.recordInvocation(ticket.operationId!, key, { tool: "dispatch_agent", params }), true);
	const guard = createNoProgressGuard(persist);
	guard.restore(entries);
	let calls = 0;
	const run = withNoProgress({ noProgress: guard, artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => { calls++; return { content: [] }; });
	for (const id of ["first-refusal", "second-refusal"]) {
		const result = await run(id, params, undefined, undefined, { cwd } as any);
		assert.equal((result.details as any).recoveryCategory, "indeterminate");
		const text = (result.content[0] as any).text as string;
		assert.ok(text.includes(ticket.operationId!));
		assert.ok(text.includes(ticket.attemptId!));
		assert.match(text, /\/af-recover inspect /);
		assert.match(text, /\/af-recover abandon /);
		const durable = JSON.stringify(entries);
		for (const uuid of text.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? []) assert.ok(durable.includes(uuid), `refusal fabricated ${uuid}`);
		assert.equal((result.details as any).previousDispatchId, guard.inspect(ticket.operationId!)!.attempts[0].dispatchId);
	}
	assert.equal(calls, 0);
});

test("unterminated reservation refusal reports its real operation and attempt instead of a fabricated previous dispatch", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "held-reservation-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", cwd]);
	const entries: any[] = [];
	const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
	const key = JSON.stringify(["dispatch", cwd, "builder", ["src.ts"], [], ["src.ts"]]);
	const ticket = guard.begin(key, "revision", canonicalExecutor(cwd, "builder"), ["src.ts"]);
	guard.reset();
	let calls = 0;
	const run = withNoProgress({ noProgress: guard, artifacts: { loadInputArtifacts: () => [] } } as any, "dispatch", async () => { calls++; return { content: [] }; });
	const result = await run("refused", { agent: "builder", task: "work", scope: ["src.ts"], deliverables: ["src.ts"] }, undefined, undefined, { cwd } as any);
	const text = (result.content[0] as any).text as string;
	assert.match(text, /unterminated|pending|in.flight/i);
	assert.ok(text.includes(ticket.operationId!));
	assert.ok(text.includes(ticket.attemptId!));
	assert.match(text, /\/af-recover inspect /);
	assert.doesNotMatch(text, /Previous attempt:/);
	const durable = JSON.stringify(entries);
	for (const uuid of text.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? []) assert.ok(durable.includes(uuid), `refusal fabricated ${uuid}`);
	assert.equal(calls, 0);
});

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

test("invalid invocation reports safe field types before executor", async t => {
 const cwd = mkdtempSync(join(tmpdir(), 'field-diagnostic-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync('git', ['init', '-q', cwd]);
 let calls = 0;
 const run = withNoProgress({ noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } } as any, 'dispatch', async () => { calls++; return { content: [] }; });
 const result = await run('one', { agent: 'builder', task: 'secret task', watchdog: 'secret-value' } as any, undefined, undefined, { cwd } as any);
 assert.deepEqual((result.details as any).diagnostics, [{ field: 'watchdog', expected: 'boolean', actual: 'string' }]);
 assert.doesNotMatch(JSON.stringify(result), /secret/);
 assert.equal(calls, 0);
});

for (const kind of ['dispatch', 'research'] as const) test(`${kind} field diagnostics cover required, arrays, enum and unsafe keys`, async () => {
 const base = kind === 'dispatch' ? { agent: 'builder', task: 'secret task' } : { task: 'secret task' };
 const cases: [any, string, string, string][] = [
  [{ task: undefined }, 'task', 'nonblank string', 'missing'], [{ task: ' ' }, 'task', 'nonblank string', 'string'],
  [{ artifacts: 'secret' }, 'artifacts', 'array of strings', 'string'], [{ artifacts: [false] }, 'artifacts[0]', 'string', 'boolean'],
  [{ 'secret\nkey': 1 }, 'params.<unknown-key>', 'supported field', 'number'],
  ...(kind === 'dispatch' ? [
   [{ agent: 1 }, 'agent', 'nonblank string', 'number'],
   [{ scope_mode: 'secret' }, 'scope_mode', 'existing | create', 'string'],
   [{ backend: 'secret' }, 'backend', 'auto | native | coms', 'string'],
   [{ triage_reason: 'secret' }, 'triage_reason', 'used | better_fit | changed_scope | independent_judgment', 'string'],
  ] as [any, string, string, string][] : [[{ read_scope: [false] }, 'read_scope[0]', 'string', 'boolean'], [{ read_scope: ['../secret'] }, 'read_scope[0]', 'repository-relative nonempty string', 'string']] as [any, string, string, string][]),
 ];
 for (const [extra, field, expected, actual] of cases) {
  let calls = 0;
  const run = withNoProgress({ noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => { throw Error('should not load'); } } } as any, kind, async () => { calls++; return { content: [] }; });
  const result = await run('one', { ...base, ...extra } as any, undefined, undefined, { cwd: '/fake' } as any);
  assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.deepEqual((result.details as any).diagnostics.map(({ field, expected, actual }: any) => ({ field, expected, actual })), [{ field, expected, actual }]);
 }
});

for (const mode of ['false', 'throw'] as const) test(`recordInvocation ${mode} releases reservation before launch and permits corrected explicit call`, async t => {
 const cwd = mkdtempSync(join(tmpdir(), 'persistence-failure-')); t.after(() => rmSync(cwd, { recursive: true, force: true })); execFileSync('git', ['init', '-q', cwd]);
 const guard = createNoProgressGuard(); const save = guard.recordInvocation;
 guard.recordInvocation = () => { if (mode === 'throw') throw Error('secret storage error'); return false; };
 let calls = 0;
 const run = withNoProgress({ noProgress: guard, artifacts: { loadInputArtifacts: () => [] } } as any, 'dispatch', async () => { calls++; return { content: [], details: { status: 'completed' } }; });
 const params = { agent: 'builder', task: 'inspect' };
 const failed = await run('one', params, undefined, undefined, { cwd } as any);
 assert.equal((failed.details as any).reason, 'invocation_persistence_failed'); assert.equal((failed.details as any).started, false);
 assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(failed), /secret/);
 guard.recordInvocation = save;
 const next = await run('two', params, undefined, undefined, { cwd } as any);
 assert.equal((next.details as any).status, 'completed'); assert.equal(calls, 1);
});

test('registered tool schemas retain runtime optional fields and provider compatible enums', async () => {
 const { registerHooks } = await import('node:module');
 const tuiPackage = import.meta.resolve('@earendil-works/pi-tui');
 const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === '@mariozechner/pi-tui' ? { url: tuiPackage, shortCircuit: true } : nextResolve(specifier, context);
 } });
 const { registerDispatchAgent } = await import('./tools/dispatch-agent.ts');
 const { registerSpawnResearch } = await import('./tools/spawn-research.ts');
 const tools: any[] = []; const pi: any = { registerTool: (tool: any) => tools.push(tool) };
 registerDispatchAgent(pi, {} as any); registerSpawnResearch(pi, {} as any);
 assert.deepEqual(Object.keys(tools[0].parameters.properties).sort(), ['agent','task','artifacts','scope','scope_mode','deliverables','watchdog','review_reason','review_mode','backend','parallel','triage_id','triage_reason','private_config_files','verifier_sources'].sort());
 assert.equal(tools[0].parameters.properties.parallel.type, 'boolean', 'the parallel writer flag is an optional boolean');
 const schema = tools[0].parameters, fields = schema.properties;
 assert.deepEqual(schema.required, ['agent', 'task'], 'new private declarations remain opt-in');
 for (const name of ['private_config_files', 'verifier_sources', 'artifacts', 'scope', 'deliverables']) {
  assert.equal(fields[name].type, 'array'); assert.equal(fields[name].items.type, 'string');
 }
 for (const [name, values] of Object.entries({ review_mode: ['changes','operator-current-state','private-config-current-state'], backend: ['auto','native','coms'], scope_mode: ['existing','create'], triage_reason: ['used','better_fit','changed_scope','independent_judgment'] })) {
  assert.deepEqual(fields[name].anyOf.map((v: any) => v.const), values);
  assert.equal(Object.hasOwn(fields[name], 'default'), false, 'runtime, not schema, owns defaults');
 }
 assert.equal(fields.watchdog.type, 'boolean');
 for (const name of ['agent','task','review_reason','triage_id']) assert.equal(fields[name].type, 'string');
 assert.deepEqual(Object.keys(tools[1].parameters.properties).sort(), ['task','persona','model','artifacts','read_scope','goal','expected_result'].sort());
 assert.doesNotMatch(JSON.stringify(tools.map(t => t.parameters)), /\(\?[=!<]/);
 for (const tool of tools) {
  const kind = tool.name === 'dispatch_agent' ? 'dispatch' : 'research';
  const params = kind === 'dispatch' ? { agent: 'builder', task: 'inspect', artifacts: [], scope: [], deliverables: [], scope_mode: 'create', watchdog: false, review_reason: '', review_mode: 'changes', backend: 'native', triage_id: 'id', triage_reason: 'better_fit' } : { task: 'inspect', persona: 'researcher', model: 'model', artifacts: [], read_scope: ['src'], goal: 'find', expected_result: 'evidence' };
  let calls = 0;
  const run = withNoProgress({ noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } } as any, kind, async () => { calls++; return { content: [] }; });
  await run('one', params as any, undefined, undefined, { cwd: process.cwd() } as any);
  assert.equal(calls, 1);
 }
 hooks.deregister();
});

test('actual invocation storage exception is safe no-launch history, never indeterminate', async t => {
 const cwd = mkdtempSync(join(tmpdir(), 'storage-failure-')); t.after(() => rmSync(cwd, { recursive: true, force: true })); execFileSync('git', ['init', '-q', cwd]);
 let fail = true; const rows: any[] = [];
 const guard = createNoProgressGuard((_type, data: any) => {
  if (fail && data.event?.type === 'invocation') throw Error('secret storage body');
  rows.push(data);
 });
 let launches = 0;
 const run = withNoProgress({ noProgress: guard, artifacts: { loadInputArtifacts: () => [] } } as any, 'dispatch', async () => { launches++; return { content: [], details: { status: 'completed' } }; });
 const params = { agent: 'builder', task: 'inspect' };
 const result = await run('one', params, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).reason, 'invocation_persistence_failed'); assert.equal(launches, 0);
 const failure = rows.find(row => row.kind === 'guard' && row.event?.type === 'failure').event.failure;
 assert.equal(failure.category, 'not_started'); assert.equal(failure.noLaunchEstablished, true);
 const op = guard.byDispatch(failure.dispatchId)!;
 assert.equal(op.attempts.at(-1)?.category, 'not_started');
 assert.equal(guard.isIdle(op.executor), true);
 fail = false; await run('two', params, undefined, undefined, { cwd } as any); assert.equal(launches, 1);
});


test("orchestrator resolves all specialist questions without impersonating a user", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "orchestrator-answer-"));
 try {
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  writeFileSync(join(cwd, "a.ts"), "a");
  let calls = 0;
  const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
  const run = withNoProgress(d, "dispatch", async () => ({ content: [], details: {
   status: "blocked_on_user", recoveryCategory: "blocked_on_user", questions: ["Which file?", "Which pattern?"], exitCode: 0, dispatchId: `ask-${++calls}`,
  } }), () => ({ model: "m" }));
  const base: any = { agent: "builder", task: "edit", scope: ["a.ts"] };
  const invoke = (task: string, scope = base.scope) => run("id", { ...base, task, scope }, undefined, undefined, { cwd } as any);
  await invoke("edit");
  const answers = [
   { question: "Which file?", answer: "a.ts", basis: "repository_fact", evidence: "Repository inventory contains a.ts" },
   { question: "Which pattern?", answer: "Use the adjacent helper convention", basis: "routine_technical", evidence: "Local implementation detail; unchanged public contract" },
  ];
  const marker = (value: unknown) => `ORCHESTRATOR_ANSWER: ${JSON.stringify(value)}`;
  for (const value of [
   { dispatchId: "unknown", answers },
   { dispatchId: "ask-1", answers: answers.slice(0, 1) },
   { dispatchId: "ask-1", answers: answers.map(a => ({ ...a, answer: "" })) },
   { dispatchId: "ask-1", answers: answers.map(a => ({ ...a, basis: "new_permission" })) },
  ]) {
   assert.equal((await invoke(marker(value))).details.status, "no_progress_refused");
  }
  assert.equal((await invoke("ORCHESTRATOR_ANSWER: not-json")).details.status, "no_progress_refused");
  assert.equal(calls, 1);
  const valid = marker({ dispatchId: "ask-1", answers });
  assert.equal((await invoke(valid)).details.status, "blocked_on_user");
  assert.equal(calls, 2, "parent answer resumes the specialist");
  assert.equal((await invoke(valid)).details.status, "no_progress_refused", "old answer cannot resume a new question round");
  assert.deepEqual(d.noProgress.userAnswerCapabilities(), { filesystem: false, network: false, cloud: false, secrets: false });
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("parent clarification is scoped, cancellable, task-bound and cannot clear effect fences", () => {
 const scope = ["a.ts"];
 const answer = (dispatchId: string) => ({ dispatchId, answers: [{ question: "Pattern?", answer: "Adjacent convention", basis: "routine_technical", evidence: "Same local contract" }] });
 const block = (g: ReturnType<typeof createNoProgressGuard>, id: string, category = "blocked_on_user") => {
  const ticket = g.begin("edit", "same", "builder", scope);
  g.finish(ticket, "same", { ...failed(id, category), questions: ["Pattern?"] });
 };
 const g = createNoProgressGuard(); block(g, "ask");
 assert.equal(g.recordOrchestratorAnswer(answer("ask"), ["other.ts"]), false);
 assert.equal(g.recordOrchestratorAnswer(answer("ask"), scope), true);
 assert.equal(g.cancelUserAnswer("ask"), true);
 assert.equal(g.begin("edit", "same", "builder", scope).allowed, false);
 g.adopt("new-task");
 assert.equal(g.recordOrchestratorAnswer(answer("ask"), scope), false, "old questions cannot be re-granted in a new task");
 for (const category of ["operator_cancelled", "indeterminate", "tool_protocol_error"]) {
  const fenced = createNoProgressGuard(); block(fenced, "fence", category);
  assert.equal(fenced.recordOrchestratorAnswer(answer("fence"), scope), false);
  assert.equal(fenced.begin("edit", "changed", "builder", scope).allowed, false);
 }
});

test('corrected scope mode retries a no-launch preflight without manual recovery; unchanged input stays blocked',async t=>{
 const cwd=mkdtempSync(join(tmpdir(),'scope-recovery-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 let calls=0;
 const run=withNoProgress({noProgress:createNoProgressGuard(),artifacts:{loadInputArtifacts:()=>[]}} as any,'dispatch',async(_id,params:any)=>{
  calls++;return params.scope_mode==='create'?{content:[]}:{content:[],details:{status:'scope_preflight_failed',recoveryCategory:'not_started',started:false,notStarted:true,effects:'none',exitCode:1}};
 });
 const base:any={agent:'builder',task:'task',scope:['new-file.ts']};
 await run('1',base,undefined,undefined,{cwd} as any);
 assert.equal((await run('2',base,undefined,undefined,{cwd} as any)).details?.status,'no_progress_refused');assert.equal(calls,1);
 await run('3',{...base,scope_mode:'create'},undefined,undefined,{cwd} as any);assert.equal(calls,2);
});

test('acknowledged external blocker changes preflight conditions without resetting the task',async()=>{
 let acknowledged=false,calls=0;
 const run=withNoProgress({noProgress:createNoProgressGuard(),artifacts:{loadInputArtifacts:()=>[]}} as any,'dispatch',async()=>{
  calls++;return acknowledged?{content:[]}:{content:[],details:{status:'external_blocked',recoveryCategory:'not_started',started:false,effects:'none',exitCode:1}};
 },()=>({externalBlockerAcknowledged:acknowledged}));
 const params:any={agent:'builder',task:'task'};
 await run('1',params,undefined,undefined,{} as any);acknowledged=true;
 await run('2',params,undefined,undefined,{} as any);assert.equal(calls,2);
});

test('a second process restoring an unlocked session cannot poison history when the original owner finishes later', async () => {
	const entries: any[] = [];
	const persist = (customType: string, data: unknown) => entries.push({ customType, data });
	const key = JSON.stringify(["dispatch", "/w", "builder", ["x"], [], ["x"]]);
	for (const outcome of ["complete", "failure"] as const) {
		entries.length = 0;
		const owner = createNoProgressGuard(persist, new Set());
		const ticket = owner.begin(key, "fp", canonicalExecutor("/w", "builder"), ["x"]);
		assert.equal(owner.recordInvocation(ticket.operationId!, key, { tool: "dispatch_agent", params: { agent: "builder", task: "original" } }), true);
		const second = createNoProgressGuard(persist, new Set());
		second.restore(structuredClone(entries));
		assert.equal(second.inspect(ticket.operationId!)!.attempts.at(-1)!.category, "indeterminate");
		owner.finish(ticket, "fp", outcome === "failure" ? failed("late-dispatch", "verification_failed") : undefined);
		const later = createNoProgressGuard(persist, new Set());
		assert.doesNotThrow(() => later.restore(structuredClone(entries)), `late ${outcome} must replay`);
		const attempt = later.inspect(ticket.operationId!)!.attempts.at(-1)!;
		assert.equal(attempt.category, "indeterminate");
		assert.equal(attempt.lateOutcome, outcome === "complete" ? "completed" : "verification_failed");
		const notices: string[] = [];
		await runRecoverCommand(`inspect ${ticket.operationId}`, { cwd: "/w", ui: { notify: (text: string) => notices.push(text) } } as any, { noProgress: later } as any);
		const inspected = JSON.parse(notices[0]).attempts.at(-1);
		assert.deepEqual([inspected.category, inspected.interrupted, inspected.lateOutcome, inspected.settled], ["indeterminate", true, attempt.lateOutcome, false]);
		assert.equal(later.canContinue(ticket.operationId!, attempt.attemptId), true, "the fence stays until research and human approval");
		assert.equal(later.begin(key, "fp", canonicalExecutor("/w", "builder"), ["x"]).allowed, false, "unchanged replay stays fenced");
		assert.equal(later.begin(JSON.stringify(["dispatch", "/w", "planner", [], [], []]), "fp", canonicalExecutor("/w", "planner"), []).allowed, true, "unrelated dispatch is not blocked");
	}
});

// One Esc used to fence the agent for good once the task changed: /af-retry was gated on the old task id,
// abandon left the executor-wide fence in place, and restore rebuilt it on every resume.
test("a cancel fence stays liftable after a task reset, across restore, and is released by abandon", () => {
 const entries: any[] = [];
 const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
 const g = createNoProgressGuard(persist);
 const first = g.begin("work", "r", "builder");
 g.finish(first, "r", failed("cancel-a", "operator_cancelled"));
 g.reset();
 assert.equal(g.begin("other-work", "x", "builder").allowed, false, "the fence itself still needs a human grant");
 assert.equal(g.canAuthorize(first.operationId!, first.attemptId!), true, "the human grant is reachable from the next task");
 const resumed = createNoProgressGuard(persist); resumed.restore(entries);
 assert.equal(resumed.canAuthorize(first.operationId!, first.attemptId!), true, "and after resume");
 assert.equal(resumed.abandon(first.operationId!, first.attemptId!, "nonce-abandon"), true);
 assert.equal(resumed.begin("other-work", "x", "builder").allowed, true, "abandon releases the agent identity");
 assert.equal(resumed.begin("work", "r2", "builder").allowed, false, "the abandoned contract itself stays refused");
 const again = createNoProgressGuard(persist); again.restore(entries);
 assert.equal(again.begin("third-work", "y", "builder").allowed, true, "restore does not resurrect an abandoned cancel fence");
});

// Esc is a turn interrupt, not a verdict on the agent: the human's next own input lifts it once.
test("an Esc fence is lifted once by human input, a panel kill is not, and both survive restore", () => {
 const entries: any[] = [];
 const persist = (type: string, data: unknown) => entries.push({ customType: type, data });
 const g = createNoProgressGuard(persist);
 g.finish(g.begin("work", "r", "builder"), "r", { ...failed("esc-a", "operator_cancelled"), userInterrupt: true } as any);
 g.finish(g.begin("review", "r", "reviewer"), "r", failed("kill-b", "operator_cancelled"));
 assert.equal(g.begin("work", "r", "builder").allowed, false, "nothing but human input lifts the fence");
 const resumed = createNoProgressGuard(persist); resumed.restore(entries);
 assert.equal(resumed.begin("work", "r", "builder").allowed, false, "the fence survives resume");
 assert.equal(resumed.releaseUserInterrupts(), 1);
 assert.equal(resumed.releaseUserInterrupts(), 0, "the grant is issued once");
 assert.equal(resumed.begin("review", "r", "reviewer").allowed, false, "a fleet-panel kill still needs /af-retry");
 const retry = resumed.begin("work", "r", "builder");
 assert.equal(retry.allowed, true);
 resumed.finish(retry, "r");
 const again = createNoProgressGuard(persist); again.restore(entries);
 assert.equal(again.begin("review", "r", "reviewer").allowed, false);
 assert.equal(again.begin("work", "r", "builder").allowed, true, "the consumed fence does not return");
});
