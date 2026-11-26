import { intersectToolLists, isReadOnlyToolList, READ_ONLY_TOOLS } from "./helpers.ts";
import type { DispatchAgentParams } from "./tools/context.ts";

export type DispatchReviewMode = DispatchAgentParams["review_mode"];

export interface DispatchAccess {
	/** May change the working tree: an editor, never a read-only role. */
	readonly writable: boolean;
	/**
	 * A read-only role in an explicit active-check mode keeps its shell, but only
	 * under the native write-denying sandbox (empty write allowlist, decision D4).
	 * It takes no writer slot and cannot route to coms.
	 */
	readonly activeCheck?: boolean;
	/** Admission reserved an unisolated writer slot for a possible remote route. */
	readonly comsWriter?: boolean;
	readonly tools: string;
	readonly reviewMode: DispatchReviewMode;
}

const declaresShell = (tools: string) => tools.split(",").some(tool => tool.trim() === "bash");

/** The role ceiling decides access. Only an explicit active-check mode may use
 * the shell of a read-only role, and then only inside the sandbox. */
export function dispatchAccess(agent: { tools: string; readOnly?: boolean }, reviewMode?: DispatchReviewMode): DispatchAccess {
	const declared = agent.tools || READ_ONLY_TOOLS;
	if (agent.readOnly === true) {
		const activeCheck = !!reviewMode && reviewMode !== "changes" && declaresShell(declared);
		return activeCheck
			? { writable: false, activeCheck: true, tools: intersectToolLists(declared, `${READ_ONLY_TOOLS},bash`), reviewMode }
			: { writable: false, tools: intersectToolLists(declared, READ_ONLY_TOOLS), reviewMode };
	}
	return { writable: !isReadOnlyToolList(declared), tools: declared, reviewMode };
}

/**
 * Writes or runs checks: takes the sequential slot, binds runtime receipts and the
 * changed-task verdict path. A read-only active check stays tracked exactly as a
 * shell verification always was; only its tools and sandbox changed (D4).
 */
export const isTrackedAccess = (access: DispatchAccess | undefined): boolean => access?.writable === true || access?.activeCheck === true;

/** Pure inspection: read tools only, stage-guarded, no shell. */
export const isInspectionAccess = (access: DispatchAccess | undefined): boolean => access?.writable === false && access.activeCheck !== true;

export const ACTIVE_CHECK_SANDBOX_REFUSAL = "A read-only role runs checks only inside the write-denying sandbox, which is unavailable here. Assign checks that need it to an editor, then give the reviewer the editor's revision-bound results.";
