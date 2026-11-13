// Compatibility library for historical benchmark imports. No extension factory or import-time effects.
export const DIAGNOSTIC_TRANSPORT_REFUSAL_EXIT = 73;

export type ProviderOutputCapField = "max_output_tokens" | "max_completion_tokens" | "max_tokens";
export interface ProviderModelIdentity { provider?: unknown; api?: unknown; compat?: { maxTokensField?: unknown } }

/** Apply only installed, reviewed provider/API semantics; body fields alone never select a mapping. */
export function applyProviderOutputTokenCap(payload: Record<string, unknown>, model: ProviderModelIdentity | undefined, limit: unknown): { payload: Record<string, unknown>; field: ProviderOutputCapField } {
	if (limit !== 2048) throw new Error("approved output-token cap must be exactly 2048");
	const provider = model?.provider;
	const api = model?.api;
	const hasResponsesShape = typeof payload.model === "string" && payload.model.length > 0 && Array.isArray(payload.input) && payload.input.length > 0 && payload.stream === true && !Object.prototype.hasOwnProperty.call(payload, "messages");
	const hasCompletionsShape = typeof payload.model === "string" && payload.model.length > 0 && Array.isArray(payload.messages) && payload.messages.length > 0 && payload.stream === true && !Object.prototype.hasOwnProperty.call(payload, "input");
	const capFields: ProviderOutputCapField[] = ["max_output_tokens", "max_completion_tokens", "max_tokens"];
	let field: ProviderOutputCapField;
	if (provider === "xai" && api === "openai-responses" && hasResponsesShape) field = "max_output_tokens";
	else if (provider === "omlx" && api === "openai-completions" && hasCompletionsShape) {
		const configured = model?.compat?.maxTokensField;
		if (configured === undefined) field = "max_completion_tokens";
		else if (configured === "max_completion_tokens" || configured === "max_tokens") field = configured;
		else throw new Error("unsupported OMLX compat maxTokensField");
	}
	else throw new Error("unsupported provider/API output-cap semantics or payload shape");
	if (capFields.some(candidate => candidate !== field && Object.prototype.hasOwnProperty.call(payload, candidate))) throw new Error("payload contains an output-cap field incompatible with provider/API semantics");
	return { payload: { ...payload, [field]: limit }, field };
}
