import type { DeliverableReadback } from "./acceptance.ts";

export const TOOL_PROTOCOL_DIAGNOSTIC_SCHEMA = "agent-fleet.tool-protocol-diagnostic/v1" as const;

export interface ToolExecutionEvent {
	toolName: string;
	toolCallId?: string;
	args: string;
	completed: boolean;
	isError?: boolean;
}

export interface ToolProtocolOrigin {
	kind: "task" | "probe";
	taskId?: string;
	probeId?: string;
	dispatchId?: string;
}

export interface ToolProtocolConfiguration {
	backend: string | null;
	model: string | null;
	tools: string[];
	endpoint?: string;
}

export function createToolEventRecorder() {
	const events: ToolExecutionEvent[] = [];
	const indexes = new Map<string, number>();
	return {
		events,
		start(toolName: string, args: string, toolCallId?: string) {
			const index = events.push({ toolName, ...(toolCallId ? { toolCallId } : {}), args, completed: false }) - 1;
			if (toolCallId) indexes.set(toolCallId, index);
		},
		end(toolCallId: string | undefined, isError: boolean | undefined) {
			if (!toolCallId) return;
			const index = indexes.get(toolCallId);
			if (index == null) return;
			events[index] = { ...events[index], completed: true, ...(typeof isError === "boolean" ? { isError } : {}) };
			indexes.delete(toolCallId);
		},
	};
}

export interface ToolProtocolDiagnostic {
	schema: typeof TOOL_PROTOCOL_DIAGNOSTIC_SCHEMA;
	category: "tool_protocol_error";
	origin: ToolProtocolOrigin;
	effectiveConfiguration: ToolProtocolConfiguration;
	claim: { tool: "write"; path: string };
	correlation: { matchingEvents: number; deliverableStatus: DeliverableReadback["status"] | "not_declared" };
	effects: { status: "none" | "partial"; observedPaths: string[] };
	conclusion: { scope: "this_run"; statement: string };
	evidenceRefs: string[];
	message: string;
}

function withoutFencedExamples(text: string): string {
	return text.replace(/```[^\n]*\n[\s\S]*?```/g, "");
}

function terminalPseudoWrite(text: string): { tool: "write"; path: string } | null {
	const candidate = withoutFencedExamples(String(text || "")).trim();
	const xml = candidate.match(/<tool_call\b[^>]*>[\s\S]*?<function\s*=\s*["']?write["']?\s*>([\s\S]*?)<\/function>\s*<\/tool_call>\s*$/i);
	if (xml) {
		const path = xml[1].replace(/<[^>]+>/g, "").trim();
		if (path && !/\s/.test(path)) return { tool: "write", path };
	}
	const jsonLine = candidate.split(/\r?\n/).at(-1)?.trim();
	if (jsonLine?.startsWith("{") && jsonLine.endsWith("}")) {
		try {
			const value = JSON.parse(jsonLine);
			const tool = String(value.tool ?? value.name ?? value.function ?? "").toLowerCase();
			const path = String(value.path ?? value.arguments?.path ?? value.parameters?.path ?? "").trim();
			if (tool === "write" && path) return { tool: "write", path };
		} catch {}
	}
	return null;
}

function normalized(path: string): string {
	return String(path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function samePath(left: string, right: string): boolean {
	const a = normalized(left), b = normalized(right);
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function eventPath(event: ToolExecutionEvent): string | null {
	try {
		const args = JSON.parse(event.args);
		const value = args?.path ?? args?.file ?? args?.filePath;
		return typeof value === "string" ? value : null;
	} catch { return null; }
}

export function diagnoseToolProtocol(input: {
	output: string;
	toolEvents: readonly ToolExecutionEvent[];
	deliverables: readonly DeliverableReadback[];
	origin: ToolProtocolOrigin;
	effectiveConfiguration: ToolProtocolConfiguration;
	evidenceRefs?: readonly string[];
}): ToolProtocolDiagnostic | null {
	const claim = terminalPseudoWrite(input.output);
	if (!claim) return null;
	const deliverable = input.deliverables.find(item => samePath(item.path, claim.path));
	const matchingEvents = input.toolEvents.filter(event => event.toolName.toLowerCase() === claim.tool && event.completed && samePath(eventPath(event) ?? "", claim.path));
	// A real matching event means the tool protocol worked; failed effects/readback
	// remain T2 verification failures rather than being relabelled as protocol errors.
	if (matchingEvents.length > 0 || (deliverable?.status === "read" && deliverable.changed === true)) return null;
	// Without a declared target there is no trusted readback against which to call
	// terminal tool-shaped prose an unexecuted task effect.
	if (!deliverable) return null;
	const observedPaths = input.deliverables.filter(item => item.status === "read" && item.changed === true).map(item => item.path).sort();
	const otherWriteEffect = input.toolEvents.some(event => event.toolName.toLowerCase() === "write" && event.completed && event.isError !== true);
	const effectsStatus = observedPaths.length > 0 || otherWriteEffect ? "partial" : "none";
	const status = deliverable.status;
	const message = `No matching write event for ${claim.path}; declared deliverable is ${status}. Tool-shaped text was not executed.`;
	return {
		schema: TOOL_PROTOCOL_DIAGNOSTIC_SCHEMA,
		category: "tool_protocol_error",
		origin: { ...input.origin },
		effectiveConfiguration: { ...input.effectiveConfiguration, tools: [...input.effectiveConfiguration.tools] },
		claim,
		correlation: { matchingEvents: 0, deliverableStatus: status },
		effects: { status: effectsStatus, observedPaths },
		conclusion: { scope: "this_run", statement: "The claimed write is unsupported by this run's trusted tool events and deliverable readback." },
		evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
		message,
	};
}
