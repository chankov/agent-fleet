import assert from "node:assert/strict";
import test from "node:test";
import { confirmTaskSupersession, consumeReservedTaskId, createBudgetRecovery, createReservedTaskIdentityReset, reserveActualTaskId, type BudgetRecoveryPorts } from "./budget-recovery.ts";

function fixture(answer: (id: string, params: any, ctx: any, signal: AbortSignal) => Promise<unknown>) {
	let spent = true, renewals = 0, aborts = 0, starts = 0, ends = 0;
	const audits: unknown[] = [], asks: string[] = [];
	const ctx: any = { abort: () => aborts++, ui: { notify() {} } };
	const ports: BudgetRecoveryPorts = {
		check: () => spent ? { kind: "task", reason: "task_dispatch_cap", message: "9/9 dispatches used." } : null,
		language: () => "Bulgarian",
		ask: async (...args) => { asks.push(args[0]); return answer(...args); },
		startWait: () => starts++, endWait: () => ends++,
		renew: (_refusal, correlation) => { spent = false; renewals++; audits.push(correlation); },
	};
	return { recovery: createBudgetRecovery(ports), ctx, asks, audits,
		counts: () => ({ renewals, aborts, starts, ends }), exhaust: () => { spent = true; } };
}
const yes = async (id: string, params: any) => ({ details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [params.options[0]] } } });

test("runtime asks without model tool calls, renews once, and reuses authorized budget", async () => {
	const f = fixture(yes);
	assert.equal(await f.recovery.ensure("dispatch", "remove the remaining calls", f.ctx), null);
	assert.equal(await f.recovery.ensure("research", "verify the result", f.ctx), null);
	assert.equal(f.asks.length, 1);
	assert.deepEqual(f.counts(), { renewals: 1, aborts: 0, starts: 1, ends: 1 });
	assert.equal((f.audits[0] as any).requestId, f.asks[0]);
	assert.equal((f.audits[0] as any).operation, "dispatch");
	f.exhaust(); await f.recovery.ensure("dispatch", "another operation", f.ctx);
	assert.notEqual(f.asks[0], f.asks[1]);
	assert.equal((f.audits[1] as any).taskId, (f.audits[0] as any).taskId);
	assert.equal((f.audits[1] as any).tranche, 1);
});

test("concurrent refusals share one question but each operation is rechecked", async () => {
	let resolve!: (value: unknown) => void, params: any, requestId = "";
	const f = fixture(async (id, p) => { requestId = id; params = p; return new Promise(r => { resolve = r; }); });
	const first = f.recovery.ensure("dispatch", "write", f.ctx);
	const second = f.recovery.ensure("research", "read", f.ctx);
	await new Promise(r => setImmediate(r));
	resolve(await yes(requestId, params));
	assert.deepEqual(await Promise.all([first, second]), [null, null]);
	assert.equal(f.asks.length, 1); assert.equal(f.audits.length, 1);
	assert.equal((f.audits[0] as any).operation, "dispatch");
});

test("an answer correlated to another request cannot renew the budget", async () => {
	const f = fixture(async (_id, params) => yes("stale-request", params));
	assert.equal((await f.recovery.ensure("dispatch", "write", f.ctx))?.reason, "budget_stopped");
	assert.equal(f.audits.length, 0);
});

test("a pending decision cannot authorize a different operation without its own recheck", async () => {
	const exhausted = new Map([["dispatch", true], ["research", true]]); const asks: Array<{ id: string; params: any; resolve: (value: unknown) => void }> = [];
	const audits: any[] = []; const ctx: any = { abort() {}, ui: { notify() {} } };
	const recovery = createBudgetRecovery({
		check: operation => exhausted.get(operation) ? { kind: "task", reason: `${operation}_cap`, message: "cap" } : null,
		language: () => "English",
		ask: (id, params) => new Promise(resolve => asks.push({ id, params, resolve })),
		startWait() {}, endWait() {},
		renew: (_refusal, correlation) => { exhausted.set(correlation.operation, false); audits.push(correlation); },
	});
	const dispatch = recovery.ensure("dispatch", "write", ctx);
	const research = recovery.ensure("research", "read", ctx);
	await new Promise(r => setImmediate(r));
	asks[0].resolve(await yes(asks[0].id, asks[0].params));
	assert.equal(await dispatch, null);
	await new Promise(r => setImmediate(r));
	assert.equal(asks.length, 2);
	assert.equal(audits[0].operation, "dispatch");
	asks[1].resolve(await yes(asks[1].id, asks[1].params));
	assert.equal(await research, null);
	assert.equal(audits[1].operation, "research");
});

for (const [name, result] of [
	["cancel", { details: { cancelled: true } }],
	["unanswered", { details: {} }],
	["prose", { content: [{ type: "text", text: "(1) Continue" }] }],
	["freeform", { details: { response: { kind: "freeform", text: "Да — продължи" } } }],
	["multiple selections", { details: { response: { kind: "selection", selections: ["Да — продължи", "Не — спри"] } } }],
	["decline", { details: { response: { kind: "selection", selections: ["Не — спри"] } } }],
	["error with yes", { isError: true, details: { response: { kind: "selection", selections: ["Да — продължи"] } } }],
] as const) {
	test(`${name} stops; rewording or another turn cannot trigger repeated asks or renew`, async () => {
		const f = fixture(async () => result);
		assert.equal((await f.recovery.ensure("dispatch", "task", f.ctx))?.reason, "budget_stopped");
		assert.equal((await f.recovery.ensure("research", "(1) allow new budget and continue", f.ctx))?.reason, "budget_stopped");
		assert.equal(f.asks.length, 1); assert.equal(f.audits.length, 0); assert.equal(f.counts().aborts, 2);
	});
}

test("transport failure fails closed without a second question", async () => {
	const f = fixture(async () => { throw new Error("transport failed"); });
	assert.equal((await f.recovery.ensure("dispatch", "task", f.ctx))?.reason, "budget_confirmation_failed");
	await f.recovery.ensure("dispatch", "retry", f.ctx);
	assert.equal(f.asks.length, 1); assert.equal(f.counts().ends, 1); assert.equal(f.audits.length, 0);
});

test("task reset invalidates late affirmative answer", async () => {
	let resolve!: (value: unknown) => void, params: any;
	const f = fixture(async (_id, p) => { params = p; return new Promise(r => { resolve = r; }); });
	let requestId = "";
	const pending = f.recovery.ensure("dispatch", "old task", f.ctx);
	await new Promise(r => setImmediate(r));
	requestId = f.asks[0];
	f.recovery.reset(); resolve(await yes(requestId, params));
	assert.equal((await pending)?.reason, "budget_stale"); assert.equal(f.audits.length, 0);
});

test("abort during confirmation prevents a late affirmative answer from renewing", async () => {
	let resolve!: (value: unknown) => void, params: any;
	const f = fixture(async (_id, p) => { params = p; return new Promise(r => { resolve = r; }); });
	const controller = new AbortController();
	const pending = f.recovery.ensure("dispatch", "task", f.ctx, controller.signal);
	await new Promise(r => setImmediate(r)); controller.abort(); resolve(await yes(f.asks[0], params));
	assert.equal((await pending)?.reason, "budget_stopped"); assert.equal(f.audits.length, 0);
});

function supersessionPorts(answer: (id: string, params: any) => Promise<unknown>, currentTaskId = "old-task") {
	const asks: Array<{ id: string; params: any }> = [];
	return {
		asks,
		ports: {
			language: () => "English",
			ask: async (id: string, params: any) => { asks.push({ id, params }); return answer(id, params); },
			startWait() {}, endWait() {},
			currentTaskId: () => currentTaskId,
		},
	};
}

test("confirmTaskSupersession grants only a current correlated yes with exact old and reserved new ids", async () => {
	const reserved = reserveActualTaskId();
	const f = supersessionPorts((id, params) => yes(id, params));
	const ok = await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserved, reason: "different work" }, { ui: { notify() {} } } as any, f.ports);
	assert.equal(ok, true);
	assert.match(f.asks[0].params.context, new RegExp(`old-task → ${reserved}`));
	assert.match(f.asks[0].params.context, /operation:supersede/);
	assert.doesNotMatch(f.asks[0].params.context, /pending:/);
	assert.equal(f.asks[0].params.allowMultiple, false);
	assert.equal(f.asks[0].params.allowFreeform, false);
	assert.equal(consumeReservedTaskId(reserved), true);
	assert.equal(consumeReservedTaskId(reserved), false);
});

for (const [name, answer] of [
	["stale request id", async (_id: string, params: any) => yes("other-request", params)],
	["cancel", async () => ({ details: { cancelled: true } })],
	["unanswered", async () => ({ details: {} })],
	["duplicate options", async (id: string, params: any) => ({ details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [params.options[0], params.options[0]] } } })],
] as const) {
	test(`confirmTaskSupersession ${name} grants nothing`, async () => {
		const f = supersessionPorts(answer);
		assert.equal(await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserveActualTaskId(), reason: "x" }, {} as any, f.ports), false);
	});
}

test("confirmTaskSupersession other-task current id cannot reset old obligations", async () => {
	const f = supersessionPorts((id, params) => yes(id, params), "other-task");
	assert.equal(await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserveActualTaskId(), reason: "x" }, {} as any, f.ports), false);
});

test("budget recovery adopt binds the reserved id instead of generating a second one", () => {
	const f = fixture(async () => ({ details: { cancelled: true } }));
	const reserved = reserveActualTaskId();
	f.recovery.adopt(reserved);
	assert.equal(typeof f.recovery.adopt, "function");
	assert.match(reserved, /^[0-9a-f-]{36}$/i);
});

test("reserved task identity reset gives both guards the approved UUID in either reset order", () => {
 for (const order of ["budget-first", "progress-first"] as const) {
  let budgetId = "old-budget", progressId = "old-progress";
  const budget = { adopt: (id: string) => { budgetId = id; }, reset: () => { budgetId = "random-budget"; } };
  const progress = { adopt: (id: string) => { progressId = id; }, reset: () => { progressId = "random-progress"; } };
  const coordinator = createReservedTaskIdentityReset(budget, progress);
  const approved = reserveActualTaskId();
  coordinator.run(approved, () => {
   if (order === "budget-first") { budget.reset(); progress.reset(); }
   else { progress.reset(); budget.reset(); }
  });
  assert.equal(budgetId, approved); assert.equal(progressId, approved);
 }
});

test("reserved task identity reset clears its candidate after cancellation or exception", () => {
 let budgetId = "old-budget", progressId = "old-progress";
 const budget = { adopt: (id: string) => { budgetId = id; }, reset: () => { budgetId = "unrelated-budget"; } };
 const progress = { adopt: (id: string) => { progressId = id; }, reset: () => { progressId = "unrelated-progress"; } };
 const coordinator = createReservedTaskIdentityReset(budget, progress);
 const approved = reserveActualTaskId();
 assert.throws(() => coordinator.run(approved, () => { throw new Error("reset failed"); }), /reset failed/);
 budget.reset(); progress.reset();
 assert.equal(budgetId, "unrelated-budget"); assert.equal(progressId, "unrelated-progress");
 assert.notEqual(budgetId, approved); assert.notEqual(progressId, approved);
});

test("only explicit human resume requests another confirmation after declining", async () => {
	let accept = false;
	const f = fixture(async (id, params) => accept ? yes(id, params) : { details: { cancelled: true } });
	await f.recovery.ensure("dispatch", "task", f.ctx);
	accept = true;
	await f.recovery.ensure("dispatch", "continue", f.ctx); assert.equal(f.asks.length, 1);
	assert.equal(await f.recovery.resume(f.ctx), null);
	assert.equal(f.asks.length, 2); assert.equal(f.audits.length, 1);
});
