import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeQuestion } from "../ask-user-remote/runtime-ask.ts";
import type { BudgetContinuationKind } from "./budget-continuation.ts";

export type BudgetOperation = "dispatch" | "research";
export type RecoveryOperation = BudgetOperation | "retry" | "supersede";
const reservedActualTaskIds = new Set<string>();

/** Stable future task UUID reserved before the one-use supersession question. */
export function reserveActualTaskId(): string {
	const id = randomUUID();
	reservedActualTaskIds.add(id);
	return id;
}

/** Consume a reserved id exactly once; refused if missing or already used. */
export function consumeReservedTaskId(id: string): boolean {
	return reservedActualTaskIds.delete(id);
}
export interface BudgetRefusal { kind: BudgetContinuationKind; reason: string; message: string; }
export interface BudgetBlock { reason: string; message: string; }
export interface BudgetCorrelation { taskId: string; tranche: number; requestId: string; operation: RecoveryOperation; }
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
	adopt(id: string): void;
	reset(): void;
}

/** Keeps the approved identity scoped to one synchronous task-window reset. */
export function createReservedTaskIdentityReset(
	budgetRecovery: Pick<BudgetRecovery, "adopt" | "reset">,
	noProgress: { adopt(id: string): void; reset(): void },
) {
	let reservedId: string | undefined;
	const rawBudgetReset = budgetRecovery.reset.bind(budgetRecovery);
	const rawNoProgressReset = noProgress.reset.bind(noProgress);
	budgetRecovery.reset = () => { if (reservedId) budgetRecovery.adopt(reservedId); else rawBudgetReset(); };
	noProgress.reset = () => { if (reservedId) noProgress.adopt(reservedId); else rawNoProgressReset(); };
	return {
		run(id: string, resetTaskWindow: () => void) {
			if (reservedId) throw new Error("A reserved task identity reset is already active.");
			reservedId = id;
			try { resetTaskWindow(); }
			finally { reservedId = undefined; }
		},
	};
}

function isAffirmative(result: unknown, question: RuntimeQuestion, correlation: BudgetCorrelation): boolean {
	const value = result as { isError?: boolean; details?: { cancelled?: boolean; runtimeAsk?: { requestId?: unknown }; response?: { kind?: string; selections?: unknown[] } } } | null;
	const response = value?.details?.response;
	return !value?.isError && value?.details?.cancelled !== true && value?.details?.runtimeAsk?.requestId === correlation.requestId &&
		response?.kind === "selection" && response.selections?.length === 1 && response.selections[0] === question.options[0];
}

export interface RetryAuthorizationPorts {
	taskId(): string;
	language(): string;
	ask(id: string, params: RuntimeQuestion, ctx: ExtensionContext, signal: AbortSignal): Promise<unknown>;
	startWait(id: string): void;
	endWait(id: string, sameTask: boolean): void;
	authorize(dispatchId: string): boolean;
}

/** Ask for the existing operator-cancellation permission; never retries or renews a budget. */
export async function confirmOneUseRetry(dispatchId: string, ctx: ExtensionContext, ports: RetryAuthorizationPorts, signal?: AbortSignal): Promise<{ authorized: boolean; reason: string; correlation: BudgetCorrelation }> {
	const correlation: BudgetCorrelation = { taskId: ports.taskId(), tranche: 0, requestId: randomUUID(), operation: "retry" };
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	const bg = /bulgarian|българ/i.test(ports.language());
	const params: RuntimeQuestion = {
		question: bg ? "Да разреша ли еднократно повторение след отмяна от оператор?" : "Authorize one retry after operator cancellation?",
		context: `${bg ? "Отменено изпълнение" : "Cancelled run"}: ${dispatchId}\n${correlation.taskId} · ${correlation.operation} · ${correlation.requestId}`,
		options: bg ? ["Да — разреши веднъж", "Не — не разрешавай"] : ["Yes — authorize once", "No — do not authorize"],
		allowMultiple: false, allowFreeform: false, allowComment: false,
	};
	let result: unknown;
	ports.startWait(correlation.requestId);
	try { result = await ports.ask(correlation.requestId, params, ctx, controller.signal); }
	catch { return { authorized: false, reason: "retry_confirmation_failed", correlation }; }
	finally { ports.endWait(correlation.requestId, ports.taskId() === correlation.taskId); signal?.removeEventListener("abort", abort); }
	if (controller.signal.aborted || ports.taskId() !== correlation.taskId || !isAffirmative(result, params, correlation)) return { authorized: false, reason: "retry_stale_or_denied", correlation };
	return ports.authorize(dispatchId)
		? { authorized: true, reason: "retry_authorized_once", correlation }
		: { authorized: false, reason: "retry_unknown_stale_or_duplicate", correlation };
}

export interface TaskSupersessionPorts {
 language(): string;
 ask(id: string, params: RuntimeQuestion, ctx: ExtensionContext, signal: AbortSignal): Promise<unknown>;
 startWait(id: string): void;
 endWait(id: string, sameTask: boolean): void;
 currentTaskId(): string;
}

/** One-use operator decision bound to old/new task identities; callers mutate state only after true. */
export async function confirmTaskSupersession(input: { oldTaskId: string; newTaskId: string; reason: string }, ctx: ExtensionContext, ports: TaskSupersessionPorts, signal?: AbortSignal): Promise<boolean> {
 const requestId = randomUUID(), controller = new AbortController(), abort = () => controller.abort();
 if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
 const bg = /bulgarian|българ/i.test(ports.language());
 const question: RuntimeQuestion = { question: bg ? "Да изоставя ли еднократно отворените задължения на старата задача?" : "Authorize one-time abandonment of the old task's open obligations?", context: `${input.oldTaskId} → ${input.newTaskId}\n${input.reason}\noperation:supersede\n${requestId}`, options: bg ? ["Да — замени задачата", "Не — запази старата"] : ["Yes — supersede once", "No — keep old task"], allowMultiple: false, allowFreeform: false, allowComment: false };
 ports.startWait(requestId); let result: unknown;
 try { result = await ports.ask(requestId, question, ctx, controller.signal); } catch { return false; }
 finally { ports.endWait(requestId, ports.currentTaskId() === input.oldTaskId); signal?.removeEventListener("abort", abort); }
 const correlation: BudgetCorrelation = { taskId: input.oldTaskId, tranche: 0, requestId, operation: "supersede" };
 return !controller.signal.aborted && ports.currentTaskId() === input.oldTaskId && isAffirmative(result, question, correlation);
}

/** Task-scoped, single-flight human authorization. Tool prose is never an input. */
export function createBudgetRecovery(ports: BudgetRecoveryPorts): BudgetRecovery {
	let taskId = randomUUID(), tranche = 0;
	let stopped: { refusal: BudgetRefusal; operation: BudgetOperation; next: string; block: BudgetBlock } | null = null;
	let pending: { controller: AbortController; operation: BudgetOperation; result: Promise<BudgetBlock | null> } | null = null;
	const block = (ctx: ExtensionContext, reason = "budget_stopped", detail = ""): BudgetBlock => {
		const message = /bulgarian|българ/i.test(ports.language())
			? `Бюджетът не е разрешен. Изпълнението е спряно. Само човекът може да поиска ново потвърждение с /af-budget-continue.${detail ? ` ${detail}` : ""}`
			: `Budget not authorized. Execution stopped. Only the human may request confirmation again with /af-budget-continue.${detail ? ` ${detail}` : ""}`;
		ctx.ui.notify(message, "warning");
		ctx.abort();
		return { reason, message };
	};
	const confirm = (refusal: BudgetRefusal, operation: BudgetOperation, next: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (pending) return pending.result;
		const correlation = { taskId, tranche, requestId: randomUUID(), operation };
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		const bg = /bulgarian|българ/i.test(ports.language());
		const params: RuntimeQuestion = {
			question: bg ? "Да разреша ли още един бюджетен прозорец за същата задача?" : "Authorize one more budget window for this same task?",
			context: `${refusal.message}\n${bg ? "Следваща операция" : "Next operation"}: ${operation} · ${next.slice(0, 500)}\n${refusal.kind} · ${correlation.taskId} · ${correlation.tranche} · ${correlation.requestId}`,
			options: bg ? ["Да — продължи", "Не — спри"] : ["Yes — continue", "No — stop"],
			allowMultiple: false, allowFreeform: false, allowComment: false,
		};
		// Defer execution until the single-flight latch is installed.
		const current = { controller, operation, result: Promise.resolve(null) as Promise<BudgetBlock | null> };
		pending = current;
		current.result = Promise.resolve().then(async () => {
			let result: unknown, failure = "";
			ports.startWait(correlation.requestId);
			try { result = await ports.ask(correlation.requestId, params, ctx, controller.signal); }
			catch (error) { failure = error instanceof Error ? error.message : String(error); }
			finally { ports.endWait(correlation.requestId, taskId === correlation.taskId); signal?.removeEventListener("abort", abort); }
			// Task reset, abort, or a replay can never authorize a different tranche.
			if (taskId !== correlation.taskId || tranche !== correlation.tranche) return { reason: "budget_stale", message: "Stale budget confirmation ignored; no operation authorized." };
			if (controller.signal.aborted || !isAffirmative(result, params, correlation)) {
				const denied = block(ctx, failure ? "budget_confirmation_failed" : "budget_stopped", failure);
				stopped = { refusal, operation, next, block: denied }; return denied;
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
				const active = pending;
				const result = await active.result;
				if (signal?.aborted) return { reason: "budget_stopped", message: "Operation cancelled before dispatch." };
				if (result || active.operation === operation) return result;
				const refusal = ports.check(operation);
				return refusal ? confirm(refusal, operation, next, ctx, signal) : null;
			}
			const refusal = ports.check(operation);
			return refusal ? confirm(refusal, operation, next, ctx, signal) : null;
		},
		async resume(ctx) {
			if (pending) return pending.result;
			if (!stopped) return null;
			const previous = stopped; stopped = null;
			return confirm(previous.refusal, previous.operation, previous.next, ctx);
		},
		adopt(id: string) { taskId = id; tranche = 0; stopped = null; pending?.controller.abort(); pending = null; },
		reset() { this.adopt(randomUUID()); },
	};
}
