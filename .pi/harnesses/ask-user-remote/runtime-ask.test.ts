import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { installAskUserRemote } from "./index.ts";
import { requestRuntimeAsk, type RuntimeQuestion } from "./runtime-ask.ts";
import { QuestionChannel } from "./questions.ts";

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
	assert.equal(localSignal?.aborted, true);
	assert.equal(channel.list(owner).questions.length, 0);
	assert.notEqual(channel.submit(owner, question.id, "yes-2", { kind: "selection", selections: ["Да"] }).status, "accepted");
});

test("missing wrapper uses local dialog; cancellation and absence of all UI fail closed", async () => {
	const events = createEventBus(); let calls = 0;
	const ctx: any = { hasUI: true, ui: { select: async (_title: string, options: string[]) => { calls++; return options[0]; } } };
	assert.equal((await requestRuntimeAsk(events, "local", params, ctx) as any).details.response.selections[0], "Да");
	ctx.ui.select = async () => undefined;
	assert.equal((await requestRuntimeAsk(events, "cancel", params, ctx) as any).details.cancelled, true);
	assert.equal(calls, 1);
	await assert.rejects(requestRuntimeAsk(events, "headless", params, { hasUI: false } as any), /no ask-user transport or local UI/);
});

test("aborted runtime question opens neither wrapper nor fallback", async () => {
	const events = createEventBus(); const controller = new AbortController(); controller.abort();
	const result = await requestRuntimeAsk(events, "aborted", params, { hasUI: true, ui: { select: () => assert.fail("cancelled") } } as any, controller.signal);
	assert.equal((result as any).details.cancelled, true);
});
