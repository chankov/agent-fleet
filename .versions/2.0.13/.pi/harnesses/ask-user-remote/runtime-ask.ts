import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface RuntimeQuestion {
	question: string;
	context: string;
	options: string[];
	allowMultiple: false;
	allowFreeform: false;
	allowComment: false;
}
export interface RuntimeAskBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
type ExecuteAsk = (id: string, params: RuntimeQuestion, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => unknown;
interface Request {
	id: string; params: RuntimeQuestion; signal?: AbortSignal; ctx: ExtensionContext;
	result?: Promise<unknown>;
}
const CHANNEL = "agent-fleet:runtime-ask";
const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);

function validateSingleDecision(id: unknown, value: unknown): asserts value is RuntimeQuestion {
	if (!validRequestId(id)) throw new Error("Invalid runtime ask question: request id must be a stable non-empty identifier.");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime ask question: expected an object.");
	const question = value as Partial<RuntimeQuestion>;
	if (typeof question.question !== "string" || !question.question.trim() || typeof question.context !== "string") throw new Error("Invalid runtime ask question: question and context must be strings.");
	if (!Array.isArray(question.options) || question.options.length !== 2 || question.options.some(option => typeof option !== "string" || !option.trim()) || new Set(question.options).size !== 2) {
		throw new Error("Invalid runtime ask question: options must be exactly two unique non-empty strings.");
	}
	if (question.allowMultiple !== false || question.allowFreeform !== false || question.allowComment !== false) {
		throw new Error("Invalid runtime ask question: one question permits exactly one selection and no freeform or comment answer.");
	}
}

function correlateResult(id: string, result: unknown): unknown {
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid runtime ask result: expected an object.");
	const value = result as Record<string, unknown>;
	const details = value.details && typeof value.details === "object" && !Array.isArray(value.details) ? value.details as Record<string, unknown> : {};
	return { ...value, details: { ...details, runtimeAsk: { requestId: id } } };
}

/** The existing wrapper owns local/remote racing; no second transport or tool registration. */
export function registerRuntimeAsk(bus: RuntimeAskBus, execute: ExecuteAsk): () => void {
	return bus.on(CHANNEL, value => {
		const request = value as Request;
		if (request.result) return; // one owner, even if a wrapper was loaded twice
		request.result = Promise.resolve().then(() => {
			validateSingleDecision(request.id, request.params);
			return request.signal?.aborted
				? { details: { cancelled: true } }
				: execute(request.id, request.params, request.signal, undefined, request.ctx);
		}).then(result => correlateResult(request.id, result));
	});
}

/** Missing wrapper falls back to an explicit local dialog, never to model prose. */
export async function requestRuntimeAsk(bus: RuntimeAskBus, id: string, params: RuntimeQuestion, ctx: ExtensionContext, signal?: AbortSignal): Promise<unknown> {
	validateSingleDecision(id, params);
	if (signal?.aborted) return correlateResult(id, { details: { cancelled: true } });
	const request: Request = { id, params, ctx, signal };
	bus.emit(CHANNEL, request);
	if (request.result) return request.result;
	if (!ctx.hasUI) throw new Error("Budget confirmation unavailable: no ask-user transport or local UI.");
	const choice = await ctx.ui.select(params.question + "\n" + params.context, params.options, { signal });
	return correlateResult(id, { details: { cancelled: choice === undefined || signal?.aborted === true,
		response: { kind: "selection", selections: choice === undefined ? [] : [choice] } } });
}
