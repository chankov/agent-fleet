import { turnActiveMs } from "./run-budget.js";

export type BudgetContinuationKind = "turn" | "task";
export type BudgetContinuationOutcome = "continue" | "stop";

export const BUDGET_CONTINUATION_MARKER = "agent-hub-budget-continuation";

export function budgetContinuationContext(kind: BudgetContinuationKind): string {
	return `[[${BUDGET_CONTINUATION_MARKER}:${kind}]]`;
}

export function budgetContinuationKind(context: unknown): BudgetContinuationKind | null {
	if (typeof context !== "string") return null;
	const match = new RegExp(`\\[\\[${BUDGET_CONTINUATION_MARKER}:(turn|task)\\]\\]`).exec(context);
	return (match?.[1] as BudgetContinuationKind | undefined) ?? null;
}

/** Model-facing protocol appended to a budget refusal. */
export function budgetContinuationInstruction(message: string, kind: BudgetContinuationKind, userLanguage: string): string {
	const scope = kind === "task" ? "same task with one additional task-budget window" : "same task with a fresh turn-budget window";
	return `${message}\n\n` +
		`Do not ask the human to type continue or run a slash command. Call ask_user exactly once, in ${userLanguage}, ` +
		`to ask whether to continue the ${scope}. Put ${budgetContinuationContext(kind)} in the context, summarize ` +
		`what is complete and what the next window will do, and provide exactly two single-select options in this order: ` +
		`(1) Yes — continue, (2) No — stop. Set allowFreeform to false. The first option automatically renews the ` +
		`${kind} budget; after that answer, continue directly in this tool loop without requesting another message. ` +
		`The second option or cancellation stops.`;
}

function optionTitle(option: unknown): string {
	if (typeof option === "string") return option.trim();
	if (!option || typeof option !== "object") return "";
	const title = (option as { title?: unknown }).title;
	return typeof title === "string" ? title.trim() : "";
}

function selectedAnswer(result: unknown): string {
	const response = (result as { details?: { response?: unknown } } | null)?.details?.response;
	const selections = (response as { selections?: unknown } | null)?.selections;
	if (Array.isArray(selections) && typeof selections[0] === "string") return selections[0].trim();
	return "";
}

/**
 * Interpret only a marked, ordered ask_user confirmation. The displayed labels
 * may be translated: option 1 always means continue and every later option
 * means stop. Cancellation is conservative and stops.
 */
export function budgetContinuationOutcome(
	params: { context?: unknown; options?: unknown },
	result: unknown,
): BudgetContinuationOutcome | null {
	if (!budgetContinuationKind(params.context)) return null;
	if ((result as { details?: { cancelled?: unknown } } | null)?.details?.cancelled === true) return "stop";
	if (!Array.isArray(params.options) || params.options.length < 2) return null;
	const options = params.options.map(optionTitle);
	if (!options[0] || options.some(title => !title)) return null;
	const selected = selectedAnswer(result);
	if (!selected) return null;
	const index = options.indexOf(selected);
	if (index < 0) return null;
	return index === 0 ? "continue" : "stop";
}

/** Active turn-budget time excludes both completed and currently-open asks. */
export function turnBudgetActiveMs(
	turnStartedAt: number,
	now: number,
	completedAskWaitMs = 0,
	openAskWaitMs = 0,
): number {
	return turnActiveMs(turnStartedAt, now, Math.max(0, completedAskWaitMs) + Math.max(0, openAskWaitMs));
}
