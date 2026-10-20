// One-use human authorizations for operator recovery: a retry after cancellation,
// a recover/abandon action and a task supersession. Continuation quotas were
// removed, so nothing here renews a budget.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeQuestion } from "../ask-user-remote/runtime-ask.ts";

export type RecoveryOperation = "retry" | "supersede";
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
export interface BudgetCorrelation { taskId: string; tranche: number; requestId: string; operation: RecoveryOperation; }

/** Keeps the approved identity scoped to one synchronous task-window reset. */
export function createReservedTaskIdentityReset(
	noProgress: { adopt(id: string): void; reset(persistIdentity?: boolean): void },
) {
	let reservedId: string | undefined;
	const rawNoProgressReset = noProgress.reset.bind(noProgress);
	noProgress.reset = (persistIdentity?: boolean) => { if (reservedId) noProgress.adopt(reservedId); else rawNoProgressReset(persistIdentity); };
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

export interface RecoverAuthorizationPorts extends Omit<RetryAuthorizationPorts, 'authorize'> {
 valid(): boolean;
 consume(nonce: string): boolean;
}
const pendingRecovery = new Set<string>();
/** A direct slash command cannot grant itself: only a correlated human selection consumes the nonce. */
export async function confirmRecoverAction(input: { taskId: string; operationId: string; attemptId: string; action: 'retry' | 'abandon'; category: string }, ctx: ExtensionContext, ports: RecoverAuthorizationPorts): Promise<boolean> {
 const key = input.operationId;
 if (pendingRecovery.has(key) || !ports.valid() || ports.taskId() !== input.taskId) return false;
 pendingRecovery.add(key);
 const nonce = randomUUID(), controller = new AbortController();
 const warning = input.category === 'indeterminate' ? 'WARNING: partial side effects may already exist; retry may duplicate them. The previous process must be settled.' : 'No side effects are undone by this authorization.';
 ctx.ui.notify(warning, 'warning');
 const question: RuntimeQuestion = { question: `Authorize exactly one ${input.action} for ${input.category}?`, context: `${warning}\nTask: ${input.taskId}\nOperation: ${input.operationId}\nFailed attempt: ${input.attemptId}\nAction: ${input.action}\nNonce: ${nonce}`, options: ['Yes — authorize once', 'No — deny'], allowMultiple: false, allowFreeform: false, allowComment: false };
 const correlation: BudgetCorrelation = { taskId: input.taskId, tranche: 0, requestId: nonce, operation: 'retry' };
 ports.startWait(nonce);
 try {
  const answer = await ports.ask(nonce, question, ctx, controller.signal);
  return ports.taskId() === input.taskId && ports.valid() && isAffirmative(answer, question, correlation) && ports.consume(nonce);
 } catch { return false; }
 finally { ports.endWait(nonce, ports.taskId() === input.taskId); pendingRecovery.delete(key); }
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
