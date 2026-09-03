import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export interface DispatchAgentParams {
	agent: string;
	task: string;
	artifacts?: string[];
	scope?: string[];
	watchdog?: boolean;
	review_reason?: string;
	backend?: "auto" | "native" | "coms";
}

export interface SpawnResearchParams {
	task: string;
	persona?: string;
	model?: string;
	artifacts?: string[];
}

export interface SetTaskTierParams {
	tier: string;
	reason?: string;
	new_task?: boolean;
}

export interface TeamAdjustParams {
	action: string;
	agent: string;
	reason: string;
}

export interface SetAssertionsParams {
	assertions: Array<{ id: string; tag: string; text: string; source?: string }>;
}

export interface UpdateAssertionParams {
	id: string;
	status: string;
	evidence?: string;
}

export interface ComsListParams {
	project?: string;
	include_explicit?: boolean;
}

export interface ComsSendParams {
	target: string;
	prompt: string;
	handoff_token?: string;
	conversation_id?: string;
	response_schema?: unknown;
	reply_timeout_ms?: number;
}

export interface ComsGetParams {
	msg_id: string;
}

export interface ComsAwaitParams {
	msg_id: string;
	timeout_ms?: number;
}

export interface HerdrSpawnPeerParams {
	name: string;
	runner?: "pi" | "claude-code";
	persona?: string;
	no_persona?: boolean;
	model?: string;
	extensions?: string;
	browser?: boolean;
	all_extensions?: boolean;
	direction?: "right" | "down";
}

export interface HerdrSpawnPaneParams {
	name: string;
	command: string;
	direction?: "right" | "down";
}

export interface HerdrReadPaneParams {
	pane_id: string;
	lines?: number;
}

export interface HerdrClosePaneParams {
	pane_id: string;
	reason: string;
}

export interface HerdrNotifyParams {
	title: string;
	body?: string;
}

export type ToolUpdate = AgentToolUpdateCallback<unknown> | undefined;
export type ToolExecutionResult = AgentToolResult<unknown>;

export type ToolExecutor<TParams> = (
	toolCallId: string,
	params: TParams,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdate,
	ctx: ExtensionContext,
) => Promise<ToolExecutionResult>;

/** Dependencies tool registrars receive from the hub composition root. */
export interface ToolContext {
	executeDispatchAgent: ToolExecutor<DispatchAgentParams>;
	executeSpawnResearch: ToolExecutor<SpawnResearchParams>;
	executeSetTaskTier: ToolExecutor<SetTaskTierParams>;
	executeTeamAdjust: ToolExecutor<TeamAdjustParams>;
	executeSetAssertions: ToolExecutor<SetAssertionsParams>;
	executeUpdateAssertion: ToolExecutor<UpdateAssertionParams>;
	executeGetAssertions: ToolExecutor<Record<string, never>>;
	executeComsList: ToolExecutor<ComsListParams>;
	executeComsSend: ToolExecutor<ComsSendParams>;
	executeComsGet: ToolExecutor<ComsGetParams>;
	executeComsAwait: ToolExecutor<ComsAwaitParams>;
	executeHerdrSpawnPeer: ToolExecutor<HerdrSpawnPeerParams>;
	executeHerdrSpawnPane: ToolExecutor<HerdrSpawnPaneParams>;
	executeHerdrReadPane: ToolExecutor<HerdrReadPaneParams>;
	executeHerdrClosePane: ToolExecutor<HerdrClosePaneParams>;
	executeHerdrNotify: ToolExecutor<HerdrNotifyParams>;
	getAssertionCount(): number;
}
