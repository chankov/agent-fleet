import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface TurnLifecyclePorts {
	setTurnState(state: "working" | "idle"): void;
	startMonitorTurn(): void;
	finishMonitorTurn(): void;
	startAskUser(id: string): void;
	endAskUser(id: string, endedAt: number): number;
	acknowledgeExternalBlocker(): void;
	addAskUserWait(waitMs: number): void;
	applyWorkMode(): void;
	closeTurnActiveTime(now: number): void;
	openTaskClock(now: number): void;
	startHistoryTurn(now: number): void;
	resetTurnBudgetState(): void;
	updateModeStatus(): void;
	buildPrompt(): { systemPrompt: string };
	endHistoryTurn(now: number): void;
	unaddressedPeerWarning(): string | null;
	settlePeerTurn(ctx: ExtensionContext): Promise<void>;
	settlePressure(ctx: ExtensionContext): Promise<void>;
	dispatchQueuedPeerTurn(): void;
}

export interface TurnLifecycleHandlers {
	beforeAgentPresence(): void;
	toolStart(event: any): void;
	toolEnd(event: any): void;
	beforeAgentStart(): { systemPrompt: string };
	agentEnd(ctx: ExtensionContext): Promise<void>;
	agentSettled(ctx: ExtensionContext): Promise<void>;
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
		beforeAgentPresence() { ports.setTurnState("working"); ports.finishMonitorTurn(); ports.startMonitorTurn(); },
		toolStart(event) {
			if (event.toolName !== "ask_user") return;
			ports.startAskUser(event.toolCallId);
			ports.acknowledgeExternalBlocker();
		},
		toolEnd(event) {
			if (event.toolName !== "ask_user") return;
			const endedAt = Date.now();
			ports.addAskUserWait(ports.endAskUser(event.toolCallId, endedAt));
		},
		beforeAgentStart() { resetTurn(); return ports.buildPrompt(); },
		async agentEnd(ctx) {
			const endedAt = Date.now();
			ports.closeTurnActiveTime(endedAt);
			ports.endHistoryTurn(endedAt);
			const warning = ports.unaddressedPeerWarning();
			if (warning) ctx.ui.notify(warning, "warning");
		},
		async agentSettled(ctx) {
			ports.finishMonitorTurn();
			await ports.settlePeerTurn(ctx);
			try {
				await ports.settlePressure(ctx);
			} finally {
				ports.dispatchQueuedPeerTurn();
			}
		},
	};
}

/** Custom coms messages skip before_agent_start, but every run emits agent_start. */
export function registerTurnPresence(
 events: {on(event: any, handler: (...args: any[]) => unknown): unknown},
 handlers: Pick<TurnLifecycleHandlers, "beforeAgentPresence">,
): void {
 events.on("agent_start", () => handlers.beforeAgentPresence());
}

/** Register after recovery handlers so queued peer work starts only after settlement work completes. */
export function registerTurnSettlement(
 events: {on(event: any, handler: (...args: any[]) => unknown): unknown},
 handlers: Pick<TurnLifecycleHandlers, "agentSettled">,
): void {
 events.on("agent_settled", (_event, ctx: ExtensionContext) => handlers.agentSettled(ctx));
}
