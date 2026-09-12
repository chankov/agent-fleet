import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface TurnLifecyclePorts {
	setTurnState(state: "working" | "idle"): Promise<void>;
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
			await ports.respondToPeer(ctx);
		},
	};
}

/** Custom coms messages skip before_agent_start, but every run emits agent_start. */
export function registerTurnPresence(
 events: {on(event: "agent_start" | "agent_end", handler: () => Promise<void>): unknown},
 handlers: Pick<TurnLifecycleHandlers, "beforeAgentPresence" | "agentEndPresence">,
): void {
 events.on("agent_start", () => handlers.beforeAgentPresence());
 events.on("agent_end", () => handlers.agentEndPresence());
}
