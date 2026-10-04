import { TERMINAL_TASK_STATES, validateMonitorInvoke } from "../lib/hermes-monitor-model.ts";
import { MonitorInvokeJournal } from "./monitor-invoke-journal.ts";

/** Longest evidence list rendered inline before the rest is summarized as a count. */
const RENDERED_EVIDENCE_IDS = 8;
const FOLLOW_UP_CUSTOM_TYPE = "hermes-watchdog-invoke";

export type WatchdogFollowUp = {
	message: { customType: string; content: string; display: true; details: { requestId: string; action: string } };
	options: { deliverAs: "followUp"; triggerTurn: true };
};

/**
 * The exact follow-up an accepted watchdog request becomes.
 *
 * This is the single production seam: `index.ts`, the unit tests, and the
 * disposable scenario all render through it, so "exactly one follow-up" is a
 * behavioral fact rather than a source match. It carries no dispatcher tool,
 * shell, Herdr, coms free text, or slash-command authority, and it describes a
 * queued request — it never claims the work was executed.
 */
export function renderWatchdogFollowUp(request: any): WatchdogFollowUp {
	const evidence: string[] = Array.isArray(request?.parameters?.evidenceEventIds) ? request.parameters.evidenceEventIds : [];
	const shown = evidence.slice(0, RENDERED_EVIDENCE_IDS).join(", ");
	const omitted = evidence.length - Math.min(evidence.length, RENDERED_EVIDENCE_IDS);
	const evidenceLine = omitted > 0 ? `${shown} (+${omitted} more)` : shown;
	return {
		message: {
			customType: FOLLOW_UP_CUSTOM_TYPE,
			content: [
				"[Hermes watchdog request]",
				`Task ${request.taskId} generation ${request.generation}: ${request.action}.`,
				`Evidence: ${evidenceLine}`,
			].join("\n"),
			display: true,
			details: { requestId: request.requestId, action: request.action },
		},
		options: { deliverAs: "followUp", triggerTurn: true },
	};
}

/** Bind the renderer to a `pi.sendMessage`-shaped transport. */
export function createWatchdogFollowUpEnqueue(
	sendMessage: (message: WatchdogFollowUp["message"], options: WatchdogFollowUp["options"]) => Promise<void> | void,
) {
	return (request: any) => {
		const { message, options } = renderWatchdogFollowUp(request);
		return sendMessage(message, options);
	};
}

/** Hub-only typed admission. It deliberately has no tool, shell, Herdr, or free-text surface. */
export function createMonitorInvokeAdmission(deps: {
	journal: MonitorInvokeJournal;
	task: (id: string, generation: number) => any;
	owner: () => string | undefined;
	queueDepth: () => number;
	queueLimit: number;
	enqueue?: (request: any) => Promise<void> | void;
	publish?: (kind: "action.requested" | "action.accepted" | "action.rejected" | "action.completed" | "hub.queue_depth_changed", task: any, extra?: any) => void;
}) {
	return async (request: unknown) => {
		const valid = validateMonitorInvoke(request);
		if (!valid) return { status: "unsupported" };
		const task = deps.task(valid.taskId, valid.generation);
		if (!task) return { status: "stale_generation" };
		const owner = deps.owner();
		if (!owner || task.ownerSessionId !== owner) return { status: "owner_changed" };
		if (TERMINAL_TASK_STATES.has(task.state)) return { status: "already_terminal" };
		if (deps.queueDepth() >= deps.queueLimit) return { status: "queue_full" };

		const admitted = deps.journal.admit(valid.requestId, valid);
		if ("error" in admitted) return { status: "idempotency_conflict" };
		if (admitted.duplicate) return { status: "duplicate" };

		deps.publish?.("action.requested", task);
		try {
			await deps.enqueue?.(valid);
			deps.journal.result(valid.requestId, "accepted");
			deps.publish?.("action.accepted", task);
			// sendMessage settling is the only completion this boundary owns: it never claims dispatch/tool completion.
			deps.publish?.("action.completed", task);
			deps.publish?.("hub.queue_depth_changed", task, { queueDepth: deps.queueDepth() });
			return { status: "accepted" };
		} catch {
			deps.journal.result(valid.requestId, "rejected");
			deps.publish?.("action.rejected", task);
			deps.publish?.("hub.queue_depth_changed", task, { queueDepth: deps.queueDepth() });
			return { status: "rejected" };
		}
	};
}
