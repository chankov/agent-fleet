export interface RoutingProposalInput {
	taskClass: string;
	model: string;
	maxWallMs: number;
	previousModel: string;
	evidenceRef?: string;
}

export interface RoutingProposal {
	taskClass: string;
	model: string;
	maxWallMs: number;
	previousModel: string;
	evidenceRef?: string;
	active: false;
	fallback: false;
	acceptanceWeakened: false;
	requiresApproval: true;
	shadowCompared: true;
}

export function proposeRoutingPolicy(input: RoutingProposalInput): RoutingProposal {
	return {
		taskClass: input.taskClass,
		model: input.model,
		maxWallMs: input.maxWallMs,
		previousModel: input.previousModel,
		...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
		active: false,
		fallback: false,
		acceptanceWeakened: false,
		requiresApproval: true,
		shadowCompared: true,
	};
}

export function shadowCompare(proposal: RoutingProposal, observations: { taskClass: string; toolTestMs: number | "unknown" }[]): { activate: false; reason: string } {
	const same = observations.filter(item => item.taskClass === proposal.taskClass);
	if (!same.length) return { activate: false, reason: "no observations for the same task class" };
	if (same.some(item => item.toolTestMs === "unknown")) return { activate: false, reason: "same task class still has an unknown model-versus-test split" };
	return { activate: false, reason: "shadow comparison recorded; maintainer approval is still required" };
}

export function rollbackRoutingPolicy(proposal: RoutingProposal): RoutingProposal {
	return { ...proposal, model: proposal.previousModel, active: false };
}
