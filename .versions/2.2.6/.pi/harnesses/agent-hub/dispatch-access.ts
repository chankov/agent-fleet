import { intersectToolLists, isReadOnlyToolList, READ_ONLY_TOOLS } from "./helpers.ts";
import type { DispatchAgentParams } from "./tools/context.ts";

export type DispatchReviewMode = DispatchAgentParams["review_mode"];

export interface DispatchAccess {
	readonly writable: boolean;
	/** Admission reserved an unisolated writer slot for a possible remote route. */
	readonly comsWriter?: boolean;
	readonly tools: string;
	readonly reviewMode: DispatchReviewMode;
}

/** The catalog describes default dispatch. Only an explicit verification mode
 * may use the configured shell of a persona that normally inspects. */
export function dispatchAccess(agent: { tools: string; readOnly?: boolean }, reviewMode?: DispatchReviewMode): DispatchAccess {
	const declared = agent.tools || READ_ONLY_TOOLS;
	const inspectionOnly = agent.readOnly === true && (!reviewMode || reviewMode === "changes");
	return {
		writable: !inspectionOnly && !isReadOnlyToolList(declared),
		tools: inspectionOnly ? intersectToolLists(declared, READ_ONLY_TOOLS) : declared,
		reviewMode,
	};
}
