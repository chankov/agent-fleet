import test from "node:test";
import assert from "node:assert/strict";
import { checkExternalBlockerGate } from "../external-blocker.js";
import { createTurnLifecycleHandlers, type TurnLifecyclePorts } from "./turn-handlers.ts";
import { createContextPressureLifecycle, createContextPressureRootState } from "./context-pressure.ts";

function turnFixture(order: string[], overrides: Partial<TurnLifecyclePorts> = {}) {
	return createTurnLifecycleHandlers({
		setTurnState: state => { order.push(state); }, startMonitorTurn: () => order.push("monitor-start"), finishMonitorTurn: () => order.push("monitor-finish"),
		startAskUser: () => {}, endAskUser: () => 0, getExternalBlockerMarker: () => "", acknowledgeExternalBlocker: () => {}, addAskUserWait: () => {}, applyWorkMode: () => order.push("work"), closeTurnActiveTime: () => order.push("close-clock"), openTaskClock: () => order.push("open-clock"), startHistoryTurn: () => order.push("history-start"), resetTurnBudgetState: () => order.push("budget-reset"), updateModeStatus: () => order.push("status"), buildPrompt: () => { order.push("prompt"); return { systemPrompt: "p" }; }, endHistoryTurn: () => order.push("history-end"), unaddressedPeerWarning: () => null, settlePeerTurn: async () => { order.push("peer-settle"); }, settlePressure: async () => { order.push("pressure-settle"); }, dispatchQueuedPeerTurn: () => { order.push("peer-dispatch"); },
		...overrides,
	});
}

test("turn lifecycle preserves work, clock, prompt, presence, and closeout order", async () => {
	const order: string[] = [];
	const handlers = turnFixture(order);
	handlers.beforeAgentPresence(); handlers.beforeAgentStart();
	assert.deepEqual(order, ["working", "monitor-finish", "monitor-start", "work", "close-clock", "open-clock", "history-start", "budget-reset", "status", "prompt"]);
	order.length = 0; await handlers.agentEnd({ ui: { notify() {} } } as any);
	assert.deepEqual(order, ["close-clock", "history-end"]);
	await handlers.agentSettled({ ui: { notify() {} } } as any);
	assert.deepEqual(order, ["close-clock", "history-end", "monitor-finish", "peer-settle", "pressure-settle", "peer-dispatch"]);
});

test("context pressure aborts before compaction, compacts after settle, and replays deferred input", async () => {
	const root = createContextPressureRootState(); const sent: any[] = []; const order: string[] = [];
	let compactOptions: any;
	const ctx: any = { hasUI: true, model: { contextWindow: 100 }, getContextUsage: () => ({ tokens: 89, contextWindow: 100, percent: 89 }), ui: { setStatus() {}, notify(message: string) { order.push(message); } }, abort() { order.push("abort"); }, compact(options: any) { compactOptions = options; order.push("compact"); }, isIdle: () => false };
	const lifecycle = createContextPressureLifecycle({ getState: () => root, setPressure: value => { root.pressure = value; }, getCurrentContext: () => ctx, appendEntry: () => {}, sendUserMessage: (content, options) => sent.push([content, options]), resolveCapabilities: () => order.push("resolve"), applyWorkMode: () => order.push("work"), modelWorkBlocked: () => false });
	lifecycle.messageEnd({ message: { role: "toolResult", content: ["large enough to cross the automatic threshold"] } }, ctx);
	assert.equal(root.automaticPending, true); assert.ok(order.includes("abort")); assert.equal(compactOptions, undefined);
	lifecycle.agentSettled(ctx); assert.equal(order.at(-1), "compact");
	root.deferredInputs.push({ text: "continue", streamingBehavior: "steer" }); compactOptions.onComplete();
	assert.equal(root.automaticRunning, false); assert.deepEqual(sent, [["continue", { deliverAs: "steer" }]]);
});

test("a concurrent dispatch waits for the matching external blocker answer", () => {
	let marker = "[[external-blocker:first]]";
	let acknowledged = false;
	const handlers = turnFixture([], {
		getExternalBlockerMarker: () => marker,
		acknowledgeExternalBlocker: () => { acknowledged = true; },
	});
	const gate = () => checkExternalBlockerGate({ blockers: [{ what: "missing destination" }], marker, acknowledged, askUserAvailable: true });
	const ask = (id: string, context: string) => handlers.toolStart({ toolName: "ask_user", toolCallId: id, args: { context } });
	const finish = (id: string, response: string, isError = false, cancelled = false) =>
		handlers.toolEnd({ toolName: "ask_user", toolCallId: id, result: { details: { response, cancelled } }, isError });

	ask("first", marker);
	assert.ok(gate(), "same-batch dispatch is still blocked");
	handlers.beforeAgentStart();
	assert.ok(gate(), "a new turn is not an answer");
	marker = "[[external-blocker:second]]";
	finish("first", "Confirm");
	ask("unrelated", "another question");
	finish("unrelated", "Confirm");
	ask("cancelled", marker);
	finish("cancelled", "Confirm", false, true);
	ask("errored", marker);
	finish("errored", "Confirm", true);
	ask("declined", marker);
	finish("declined", "Cancel");
	assert.ok(gate());
	ask("current", marker);
	finish("current", "Confirm");
	assert.equal(gate(), null);
});
