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

/** The existing wrapper owns local/remote racing; no second transport or tool registration. */
export function registerRuntimeAsk(bus: RuntimeAskBus, execute: ExecuteAsk): () => void {
	return bus.on(CHANNEL, value => {
		const request = value as Request;
		if (request.result) return; // one owner, even if a wrapper was loaded twice
		request.result = Promise.resolve().then(() => request.signal?.aborted
			? { details: { cancelled: true } }
			: execute(request.id, request.params, request.signal, undefined, request.ctx));
	});
}

/** Missing wrapper falls back to an explicit local dialog, never to model prose. */
export async function requestRuntimeAsk(bus: RuntimeAskBus, id: string, params: RuntimeQuestion, ctx: ExtensionContext, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) return { details: { cancelled: true } };
	const request: Request = { id, params, ctx, signal };
	bus.emit(CHANNEL, request);
	if (request.result) return request.result;
	if (!ctx.hasUI) throw new Error("Budget confirmation unavailable: no ask-user transport or local UI.");
	const choice = await ctx.ui.select(params.question + "\n" + params.context, params.options, { signal });
	return { details: { cancelled: choice === undefined || signal?.aborted === true,
		response: { kind: "selection", selections: choice === undefined ? [] : [choice] } } };
}
