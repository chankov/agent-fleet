export interface RoutingObservationInput {
	taskClass: string;
	model: string;
	wallMs: number;
	toolTestMs?: number;
	retries: number;
	refusals: number;
	contractCompliant: boolean;
	accepted: boolean;
	payload?: string;
}

export interface RoutingObservation {
	taskClass: string;
	model: string;
	wallMs: number;
	toolTestMs: number | "unknown";
	retries: number;
	refusals: number;
	contractCompliant: boolean;
	accepted: boolean;
	missingDimensions: string[];
	routingChanged: false;
}

export function recordRoutingObservation(input: RoutingObservationInput): RoutingObservation {
	const toolTestMs = typeof input.toolTestMs === "number" ? input.toolTestMs : "unknown";
	const missingDimensions = toolTestMs === "unknown" ? ["toolTestMs"] : [];
	return {
		taskClass: input.taskClass,
		model: input.model,
		wallMs: input.wallMs,
		toolTestMs,
		retries: input.retries,
		refusals: input.refusals,
		contractCompliant: input.contractCompliant,
		accepted: input.accepted,
		missingDimensions,
		routingChanged: false,
	};
}
