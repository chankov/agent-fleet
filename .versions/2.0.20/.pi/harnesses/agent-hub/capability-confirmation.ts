import type { CapabilityPack } from "./capability-packs.ts";

export type ConfirmableCapabilityPack = Exclude<CapabilityPack, "core" | "verification" | "compaction">;
export type CapabilityConfirmationStatus = "pending" | "promoted" | "declined";
export type CapabilityConfirmationState = Partial<Record<ConfirmableCapabilityPack, CapabilityConfirmationStatus>>;

export const CAPABILITY_CONFIRMATION_MARKER = "agent-hub-capability-confirmation";

export function capabilityConfirmationContext(pack: ConfirmableCapabilityPack): string {
	return `[[${CAPABILITY_CONFIRMATION_MARKER}:${pack}]]`;
}

export function capabilityConfirmationPack(context: unknown): ConfirmableCapabilityPack | null {
	if (typeof context !== "string") return null;
	const match = new RegExp(`\\[\\[${CAPABILITY_CONFIRMATION_MARKER}:(fleet|peer|workspace)\\]\\]`).exec(context);
	return (match?.[1] as ConfirmableCapabilityPack | undefined) ?? null;
}

export function capabilityConfirmationQuestion(pack: ConfirmableCapabilityPack): { question: string; context: string; options: string[] } {
	return {
		question: `Use the provisional ${pack} capability for this task?`,
		context: `${capabilityConfirmationContext(pack)} Confirm before its first side effect.`,
		options: ["Confirm", "Reject", "Cancel"],
	};
}

export function confirmationOutcome(result: unknown): "promoted" | "declined" | null {
	const value = result as { details?: { cancelled?: unknown; response?: unknown } } | null;
	if (value?.details?.cancelled === true) return "declined";
	const response = value?.details?.response;
	const answer = Array.isArray((response as { selections?: unknown })?.selections)
		? (response as { selections: unknown[] }).selections.join(" ")
		: typeof (response as { text?: unknown })?.text === "string"
			? (response as { text: string }).text
			: typeof response === "string" ? response : "";
	if (/^\s*confirm\s*$/i.test(answer)) return "promoted";
	if (/^\s*(reject|cancel)\s*$/i.test(answer)) return "declined";
	return null;
}

export function confirmationGate(state: CapabilityConfirmationState, pack: ConfirmableCapabilityPack, provisional: boolean): { allowed: true } | { allowed: false; status: "ask" | "pending" | "declined"; message: string } {
	const status = state[pack];
	if (status === "declined") return { allowed: false, status: "declined", message: `provisional ${pack} capability was declined for this task; do not perform this side effect.` };
	if (status === "promoted" || !provisional) return { allowed: true };
	if (status === "pending") return { allowed: false, status: "pending", message: `provisional ${pack} capability awaits its single human confirmation; do not repeat the question or side effect.` };
	return { allowed: false, status: "ask", message: `provisional ${pack} capability requires one human confirmation before this side effect; call ask_user with ${JSON.stringify(capabilityConfirmationQuestion(pack))}.` };
}
