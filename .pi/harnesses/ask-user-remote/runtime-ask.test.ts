import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { installAskUserRemote } from "./index.ts";
import { requestRuntimeAsk, type RuntimeQuestion } from "./runtime-ask.ts";
import { QuestionChannel } from "./questions.ts";
import { confirmOneUseRetry, createBudgetRecovery, type BudgetRecoveryPorts } from "../agent-hub/budget-recovery.ts";

const params: RuntimeQuestion = { question: "Още един бюджет?", context: "Същата задача.", options: ["Да", "Не"], allowMultiple: false, allowFreeform: false, allowComment: false };

test("runtime request reaches the installed wrapper and its correlated remote channel", async () => {
	const events = createEventBus(); const owner = { project: "af", peer: "hub", sessionId: "one", startedAt: "now" };
	const channel = new QuestionChannel(() => owner);
	let localSignal: AbortSignal | undefined;
	installAskUserRemote({ events, registerTool() {} }, {
		questionChannel: channel, startRemote: () => null,
		stockFactory: pi => pi.registerTool({ name: "ask_user", execute: (_id, _params, signal) => {
			localSignal = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve({ details: { cancelled: true } })));
		} }),
	});
	const answer = requestRuntimeAsk(events, "budget-request-1", params, { hasUI: true, ui: { select: () => assert.fail("must use wrapper, not fallback") } } as any);
	await new Promise(r => setImmediate(r));
	const question = channel.list(owner).questions[0];
	assert.equal(question.toolCallId, "budget-request-1");
	assert.equal(channel.submit(owner, question.id, "yes-1", { kind: "selection", selections: ["Да"] }).status, "accepted");
	assert.equal((await answer as any).details.response.selections[0], "Да");
	assert.equal((await answer as any).details.runtimeAsk.requestId, "budget-request-1");
	assert.equal(localSignal?.aborted, true);
	assert.equal(channel.list(owner).questions.length, 0);
	assert.notEqual(channel.submit(owner, question.id, "yes-2", { kind: "selection", selections: ["Да"] }).status, "accepted");
});

test("missing wrapper uses local dialog; cancellation and absence of all UI fail closed", async () => {
	const events = createEventBus(); let calls = 0;
	const ctx: any = { hasUI: true, ui: { select: async (_title: string, options: string[]) => { calls++; return options[0]; } } };
	const local = await requestRuntimeAsk(events, "local", params, ctx) as any;
	assert.equal(local.details.response.selections[0], "Да");
	assert.equal(local.details.runtimeAsk.requestId, "local");
	ctx.ui.select = async () => undefined;
	assert.equal((await requestRuntimeAsk(events, "cancel", params, ctx) as any).details.cancelled, true);
	assert.equal(calls, 1);
	await assert.rejects(requestRuntimeAsk(events, "headless", params, { hasUI: false } as any), /no ask-user transport or local UI/);
});

test("aborted runtime question opens neither wrapper nor fallback", async () => {
	const events = createEventBus(); const controller = new AbortController(); controller.abort();
	const result = await requestRuntimeAsk(events, "aborted", params, { hasUI: true, ui: { select: () => assert.fail("cancelled") } } as any, controller.signal);
	assert.equal((result as any).details.cancelled, true);
	assert.equal((result as any).details.runtimeAsk.requestId, "aborted");
});

for (const [name, invalid] of [
	["serialized options", { ...params, options: JSON.stringify(params.options) }],
	["multiple decisions", { ...params, options: ["A", "B", "C"] }],
	["duplicate decisions", { ...params, options: ["Да", "Да"] }],
	["multiple selection", { ...params, allowMultiple: true }],
] as const) {
	test(`runtime single-decision adapter rejects ${name}`, async () => {
		await assert.rejects(requestRuntimeAsk(createEventBus(), "invalid", invalid as any, { hasUI: true, ui: { select: () => assert.fail("invalid schema") } } as any), /Invalid runtime ask question/);
	});
}

test("budget recovery production and answer consumption stay request/task/operation correlated", async () => {
	const events = createEventBus();
	const owner = { project: "af", peer: "hub", sessionId: "integration", startedAt: "now" };
	const channel = new QuestionChannel(() => owner);
	installAskUserRemote({ events, registerTool() {} }, {
		questionChannel: channel, startRemote: () => null,
		stockFactory: pi => pi.registerTool({ name: "ask_user", execute: (_id, _params, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ details: { cancelled: true } }))) }),
	});
	let exhausted = true, renewals = 0; const audits: any[] = [];
	const ports: BudgetRecoveryPorts = {
		check: () => exhausted ? { kind: "task", reason: "task_dispatch_cap", message: "cap" } : null,
		language: () => "English",
		ask: (id, question, ctx, signal) => requestRuntimeAsk(events, id, question, ctx, signal),
		startWait() {}, endWait() {},
		renew: (_refusal, correlation) => { exhausted = false; renewals++; audits.push(correlation); },
	};
	const recovery = createBudgetRecovery(ports);
	const ctx: any = { hasUI: true, abort() {}, ui: { notify() {}, select: () => assert.fail("wrapper owns question") } };
	const pending = recovery.ensure("dispatch", "builder: implement T8", ctx);
	await new Promise(r => setImmediate(r));
	const question = channel.list(owner).questions[0];
	assert.equal(channel.submit(owner, question.id, "answer-one", { kind: "selection", selections: [question.options[0].title] }).status, "accepted");
	assert.equal(await pending, null);
	assert.equal(channel.submit(owner, question.id, "answer-one", { kind: "selection", selections: [question.options[0].title] }).status, "accepted");
	assert.equal(channel.submit(owner, question.id, "answer-two", { kind: "selection", selections: [question.options[0].title] }).status, "late");
	assert.equal(renewals, 1);
	assert.equal(audits[0].operation, "dispatch");
	assert.equal(audits[0].requestId, question.toolCallId);
});

test("operator-cancel retry question grants only its current task/request/operation once", async () => {
	const events = createEventBus();
	const owner = { project: "af", peer: "hub", sessionId: "retry", startedAt: "now" };
	const channel = new QuestionChannel(() => owner);
	installAskUserRemote({ events, registerTool() {} }, {
		questionChannel: channel, startRemote: () => null,
		stockFactory: pi => pi.registerTool({ name: "ask_user", execute: (_id, _params, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ details: { cancelled: true } }))) }),
	});
	let taskId = "task-one", grants = 0;
	const ctx: any = { hasUI: true, ui: { select: () => assert.fail("wrapper owns question") } };
	const ports = {
		taskId: () => taskId, language: () => "English",
		ask: (id: string, question: RuntimeQuestion, askCtx: any, signal: AbortSignal) => requestRuntimeAsk(events, id, question, askCtx, signal),
		startWait() {}, endWait() {},
		authorize: (dispatchId: string) => dispatchId === "cancelled-run" && grants++ === 0,
	};
	const pending = confirmOneUseRetry("cancelled-run", ctx, ports);
	await new Promise(r => setImmediate(r));
	const question = channel.list(owner).questions[0];
	assert.match(question.context, /task-one/);
	assert.match(question.context, /retry/);
	assert.match(question.context, /cancelled-run/);
	assert.equal(channel.submit(owner, question.id, "retry-answer", { kind: "selection", selections: [question.options[0].title] }).status, "accepted");
	const approved = await pending;
	assert.equal(approved.authorized, true);
	assert.equal(approved.correlation.operation, "retry");
	assert.equal(approved.correlation.requestId, question.toolCallId);
	assert.equal(channel.submit(owner, question.id, "retry-answer", { kind: "selection", selections: [question.options[0].title] }).status, "accepted");
	assert.equal(grants, 1);

	const stale = confirmOneUseRetry("cancelled-run", ctx, { ...ports, authorize: () => { grants++; return true; } });
	await new Promise(r => setImmediate(r)); taskId = "task-two";
	const staleQuestion = channel.list(owner).questions[0];
	channel.submit(owner, staleQuestion.id, "stale-answer", { kind: "selection", selections: [staleQuestion.options[0].title] });
	assert.equal((await stale).authorized, false);
	assert.equal(grants, 1);

	const cancelled = confirmOneUseRetry("cancelled-run", ctx, { ...ports, authorize: () => { grants++; return true; } });
	await new Promise(r => setImmediate(r));
	const cancelledQuestion = channel.list(owner).questions[0];
	channel.submit(owner, cancelledQuestion.id, "cancel-answer", null);
	assert.equal((await cancelled).authorized, false);
	assert.equal(grants, 1);
});
