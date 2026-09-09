import assert from "node:assert/strict";
import test from "node:test";
import { createBudgetRecovery, type BudgetRecoveryPorts } from "./budget-recovery.ts";

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
const yes = async (_id: string, params: any) => ({ details: { response: { kind: "selection", selections: [params.options[0]] } } });

test("runtime asks without model tool calls, renews once, and reuses authorized budget", async () => {
	const f = fixture(yes);
	assert.equal(await f.recovery.ensure("dispatch", "remove the remaining calls", f.ctx), null);
	assert.equal(await f.recovery.ensure("research", "verify the result", f.ctx), null);
	assert.equal(f.asks.length, 1);
	assert.deepEqual(f.counts(), { renewals: 1, aborts: 0, starts: 1, ends: 1 });
	assert.equal((f.audits[0] as any).requestId, f.asks[0]);
	f.exhaust(); await f.recovery.ensure("dispatch", "another operation", f.ctx);
	assert.notEqual(f.asks[0], f.asks[1]);
	assert.equal((f.audits[1] as any).taskId, (f.audits[0] as any).taskId);
	assert.equal((f.audits[1] as any).tranche, 1);
});

test("concurrent refusals share one human question and one renewal/audit", async () => {
	let resolve!: (value: unknown) => void, params: any;
	const f = fixture(async (_id, p) => { params = p; return new Promise(r => { resolve = r; }); });
	const first = f.recovery.ensure("dispatch", "write", f.ctx);
	const second = f.recovery.ensure("research", "read", f.ctx);
	await new Promise(r => setImmediate(r));
	resolve(await yes("id", params));
	assert.deepEqual(await Promise.all([first, second]), [null, null]);
	assert.equal(f.asks.length, 1); assert.equal(f.audits.length, 1);
});

for (const [name, result] of [
	["cancel", { details: { cancelled: true } }],
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
	const pending = f.recovery.ensure("dispatch", "old task", f.ctx);
	await new Promise(r => setImmediate(r));
	f.recovery.reset(); resolve(await yes("old", params));
	assert.equal((await pending)?.reason, "budget_stale"); assert.equal(f.audits.length, 0);
});

test("abort during confirmation prevents a late affirmative answer from renewing", async () => {
	let resolve!: (value: unknown) => void, params: any;
	const f = fixture(async (_id, p) => { params = p; return new Promise(r => { resolve = r; }); });
	const controller = new AbortController();
	const pending = f.recovery.ensure("dispatch", "task", f.ctx, controller.signal);
	await new Promise(r => setImmediate(r)); controller.abort(); resolve(await yes("id", params));
	assert.equal((await pending)?.reason, "budget_stopped"); assert.equal(f.audits.length, 0);
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
