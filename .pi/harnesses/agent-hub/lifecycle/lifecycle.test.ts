import test from "node:test";
import assert from "node:assert/strict";
import { createTurnLifecycleHandlers } from "./turn-handlers.ts";
import { createContextPressureLifecycle, createContextPressureRootState } from "./context-pressure.ts";

test("turn lifecycle preserves work, clock, prompt, presence, and closeout order", async () => {
	const order: string[] = []; const asks = new Map();
	const handlers = createTurnLifecycleHandlers({
		setTurnState: async state => { order.push(state); }, startMonitorTurn: () => order.push("monitor-start"), finishMonitorTurn: () => order.push("monitor-finish"),
		startAskUser: () => {}, endAskUser: () => 0, continuationKind: () => null, getPendingContinuation: () => null, setPendingContinuation: () => {},
		getContinuationAsk: id => asks.get(id), setContinuationAsk: (id, value) => asks.set(id, value), deleteContinuationAsk: id => asks.delete(id), acknowledgeExternalBlocker: () => {}, addAskUserWait: () => {}, continuationOutcome: () => null, continuationSnapshot: () => null, continueBudget: () => {}, appendContinuation: () => {},
		getCurrentContext: () => null, getWidgetContext: () => null, applyWorkMode: () => order.push("work"), closeTurnActiveTime: () => order.push("close-clock"), openTaskClock: () => order.push("open-clock"), startHistoryTurn: () => order.push("history-start"), resetTurnBudgetState: () => order.push("budget-reset"), updateModeStatus: () => order.push("status"), buildPrompt: () => { order.push("prompt"); return { systemPrompt: "p" }; }, endHistoryTurn: () => order.push("history-end"), unaddressedPeerWarning: () => null, respondToPeer: async () => { order.push("respond"); },
	});
	await handlers.beforeAgentPresence(); handlers.beforeAgentStart();
	assert.deepEqual(order, ["working", "monitor-finish", "monitor-start", "work", "close-clock", "open-clock", "history-start", "budget-reset", "status", "prompt"]);
	order.length = 0; await handlers.agentEndPresence(); await handlers.agentEnd({ ui: { notify() {} } } as any);
	assert.deepEqual(order, ["idle", "monitor-finish", "close-clock", "history-end", "respond"]);
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
