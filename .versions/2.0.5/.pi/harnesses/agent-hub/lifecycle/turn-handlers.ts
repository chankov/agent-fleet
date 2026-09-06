import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface AskContinuation {
	kind: "task" | "turn";
	reason: string;
	params: any;
}
export interface TurnLifecyclePorts {
	setTurnState(state: "working" | "idle"): Promise<void>;
	startMonitorTurn(): void;
	finishMonitorTurn(): void;
	startAskUser(id: string): void;
	endAskUser(id: string, endedAt: number): number;
	continuationKind(context: unknown): "task" | "turn" | null;
	getPendingContinuation(): { kind: "task" | "turn"; reason: string } | null;
	setPendingContinuation(value: { kind: "task" | "turn"; reason: string } | null): void;
	getContinuationAsk(id: string): AskContinuation | undefined;
	setContinuationAsk(id: string, value: AskContinuation): void;
	deleteContinuationAsk(id: string): void;
	acknowledgeExternalBlocker(): void;
	addAskUserWait(waitMs: number): void;
	continuationOutcome(params: any, result: unknown): "continue" | "stop" | null;
	continuationSnapshot(kind: "task" | "turn", endedAt: number): unknown;
	continueBudget(kind: "task" | "turn", endedAt: number): void;
	appendContinuation(kind: "task" | "turn", reason: string, prior: unknown, ctx?: ExtensionContext): void;
	getCurrentContext(): ExtensionContext | null;
	getWidgetContext(): ExtensionContext | null;
	applyWorkMode(): void;
	closeTurnActiveTime(now: number): void;
	openTaskClock(now: number): void;
	startHistoryTurn(now: number): void;
	resetTurnBudgetState(): void;
	updateModeStatus(): void;
	buildPrompt(): { systemPrompt: string };
	endHistoryTurn(now: number): void;
	unaddressedPeerWarning(): string | null;
	respondToPeer(ctx: ExtensionContext): Promise<void>;
}

export interface TurnLifecycleHandlers {
	beforeAgentPresence(): Promise<void>;
	agentEndPresence(): Promise<void>;
	toolStart(event: any): void;
	toolEnd(event: any): void;
	beforeAgentStart(): { systemPrompt: string };
	agentEnd(ctx: ExtensionContext): Promise<void>;
}

export function createTurnLifecycleHandlers(ports: TurnLifecyclePorts): TurnLifecycleHandlers {
	const resetTurn = () => {
		ports.applyWorkMode();
		const startedAt = Date.now();
		ports.closeTurnActiveTime(startedAt);
		ports.openTaskClock(startedAt);
		ports.startHistoryTurn(startedAt);
		ports.resetTurnBudgetState();
		ports.updateModeStatus();
	};
	return {
		async beforeAgentPresence() { await ports.setTurnState("working"); ports.finishMonitorTurn(); ports.startMonitorTurn(); },
		async agentEndPresence() { await ports.setTurnState("idle"); ports.finishMonitorTurn(); },
		toolStart(event) {
			if (event.toolName !== "ask_user") return;
			ports.startAskUser(event.toolCallId);
			const kind = ports.continuationKind(event.args?.context);
			const pending = ports.getPendingContinuation();
			if (kind && pending?.kind === kind) ports.setContinuationAsk(event.toolCallId, { kind, reason: pending.reason, params: event.args });
			ports.acknowledgeExternalBlocker();
		},
		toolEnd(event) {
			if (event.toolName !== "ask_user") return;
			const endedAt = Date.now();
			ports.addAskUserWait(ports.endAskUser(event.toolCallId, endedAt));
			const confirmation = ports.getContinuationAsk(event.toolCallId);
			ports.deleteContinuationAsk(event.toolCallId);
			if (!confirmation) return;
			const outcome = ports.continuationOutcome(confirmation.params, event.result);
			if (outcome) ports.setPendingContinuation(null);
			if (outcome !== "continue") return;
			const prior = ports.continuationSnapshot(confirmation.kind, endedAt);
			ports.continueBudget(confirmation.kind, endedAt);
			ports.appendContinuation(confirmation.kind, confirmation.reason, prior, ports.getCurrentContext() ?? undefined);
			ports.getWidgetContext()?.ui?.notify(confirmation.kind === "task" ? "Task budget continued; task tier, assertions, capabilities, and progress were preserved." : "Turn budget continued; continuing without another message.", "success");
		},
		beforeAgentStart() { resetTurn(); return ports.buildPrompt(); },
		async agentEnd(ctx) {
			const endedAt = Date.now();
			ports.closeTurnActiveTime(endedAt);
			ports.endHistoryTurn(endedAt);
			const warning = ports.unaddressedPeerWarning();
			if (warning) ctx.ui.notify(warning, "warning");
			await ports.respondToPeer(ctx);
		},
	};
}
