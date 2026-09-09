import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeQuestion } from "../ask-user-remote/runtime-ask.ts";
import type { BudgetContinuationKind } from "./budget-continuation.ts";

export type BudgetOperation = "dispatch" | "research";
export interface BudgetRefusal { kind: BudgetContinuationKind; reason: string; message: string; }
export interface BudgetBlock { reason: string; message: string; }
export interface BudgetCorrelation { taskId: string; tranche: number; requestId: string; }
export interface BudgetRecoveryPorts {
	check(operation: BudgetOperation): BudgetRefusal | null;
	language(): string;
	ask(id: string, params: RuntimeQuestion, ctx: ExtensionContext, signal: AbortSignal): Promise<unknown>;
	startWait(id: string): void;
	endWait(id: string, sameTask: boolean): void;
	renew(refusal: BudgetRefusal, correlation: BudgetCorrelation, ctx: ExtensionContext): void;
}
export interface BudgetRecovery {
	ensure(operation: BudgetOperation, next: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<BudgetBlock | null>;
	resume(ctx: ExtensionContext): Promise<BudgetBlock | null>;
	reset(): void;
}

function isAffirmative(result: unknown, question: RuntimeQuestion): boolean {
	const value = result as { isError?: boolean; details?: { cancelled?: boolean; response?: { kind?: string; selections?: unknown[] } } } | null;
	const response = value?.details?.response;
	return !value?.isError && value?.details?.cancelled !== true && response?.kind === "selection" &&
		response.selections?.length === 1 && response.selections[0] === question.options[0];
}

/** Task-scoped, single-flight human authorization. Tool prose is never an input. */
export function createBudgetRecovery(ports: BudgetRecoveryPorts): BudgetRecovery {
	let taskId = randomUUID(), tranche = 0;
	let stopped: { refusal: BudgetRefusal; next: string; block: BudgetBlock } | null = null;
	let pending: { controller: AbortController; result: Promise<BudgetBlock | null> } | null = null;
	const block = (ctx: ExtensionContext, reason = "budget_stopped", detail = ""): BudgetBlock => {
		const message = /bulgarian|българ/i.test(ports.language())
			? `Бюджетът не е разрешен. Изпълнението е спряно. Само човекът може да поиска ново потвърждение с /af-budget-continue.${detail ? ` ${detail}` : ""}`
			: `Budget not authorized. Execution stopped. Only the human may request confirmation again with /af-budget-continue.${detail ? ` ${detail}` : ""}`;
		ctx.ui.notify(message, "warning");
		ctx.abort();
		return { reason, message };
	};
	const confirm = (refusal: BudgetRefusal, next: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (pending) return pending.result;
		const correlation = { taskId, tranche, requestId: randomUUID() };
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		const bg = /bulgarian|българ/i.test(ports.language());
		const params: RuntimeQuestion = {
			question: bg ? "Да разреша ли още един бюджетен прозорец за същата задача?" : "Authorize one more budget window for this same task?",
			context: `${refusal.message}\n${bg ? "Следваща операция" : "Next operation"}: ${next.slice(0, 500)}\n${refusal.kind} · ${correlation.taskId} · ${correlation.tranche} · ${correlation.requestId}`,
			options: bg ? ["Да — продължи", "Не — спри"] : ["Yes — continue", "No — stop"],
			allowMultiple: false, allowFreeform: false, allowComment: false,
		};
		// Defer execution until the single-flight latch is installed.
		const current = { controller, result: Promise.resolve(null) as Promise<BudgetBlock | null> };
		pending = current;
		current.result = Promise.resolve().then(async () => {
			let result: unknown, failure = "";
			ports.startWait(correlation.requestId);
			try { result = await ports.ask(correlation.requestId, params, ctx, controller.signal); }
			catch (error) { failure = error instanceof Error ? error.message : String(error); }
			finally { ports.endWait(correlation.requestId, taskId === correlation.taskId); signal?.removeEventListener("abort", abort); }
			// Task reset, abort, or a replay can never authorize a different tranche.
			if (taskId !== correlation.taskId || tranche !== correlation.tranche) return { reason: "budget_stale", message: "Stale budget confirmation ignored; no operation authorized." };
			if (controller.signal.aborted || !isAffirmative(result, params)) {
				const denied = block(ctx, failure ? "budget_confirmation_failed" : "budget_stopped", failure);
				stopped = { refusal, next, block: denied }; return denied;
			}
			tranche++;
			ports.renew(refusal, correlation, ctx);
			return null;
		}).finally(() => { if (pending === current) pending = null; });
		return current.result;
	};
	return {
		async ensure(operation, next, ctx, signal) {
			if (signal?.aborted) return { reason: "budget_stopped", message: "Operation cancelled before dispatch." };
			if (stopped) { ctx.abort(); return stopped.block; }
			if (pending) {
				const result = await pending.result;
				return signal?.aborted ? { reason: "budget_stopped", message: "Operation cancelled before dispatch." } : result;
			}
			const refusal = ports.check(operation);
			return refusal ? confirm(refusal, next, ctx, signal) : null;
		},
		async resume(ctx) {
			if (pending) return pending.result;
			if (!stopped) return null;
			const previous = stopped; stopped = null;
			return confirm(previous.refusal, previous.next, ctx);
		},
		reset() { taskId = randomUUID(); tranche = 0; stopped = null; pending?.controller.abort(); pending = null; },
	};
}
