import type { Posture } from "./posture.ts";
import type { CapabilityConfirmationState } from "./capability-confirmation.ts";

export const CAPABILITY_PACKS = ["core", "fleet", "verification", "peer", "workspace", "compaction"] as const;
export type CapabilityPack = (typeof CAPABILITY_PACKS)[number];
export type TaskTier = "trivial" | "small" | "feature" | "project";
export type ContextState = "normal" | "approaching-compaction" | "imminent-compaction";

export interface PendingOperation {
	pack: Exclude<CapabilityPack, "core">;
	kind: string;
}

export interface CapabilityResolutionInput {
	posture: Posture;
	userText: string;
	taskTier?: TaskTier;
	taskPacks: readonly CapabilityPack[];
	/** Provisional packs persist as provisional; they must never silently become active. */
	provisionalPacks?: readonly CapabilityPack[];
	comsReady: boolean;
	herdrReady: boolean;
	pendingOperations: readonly PendingOperation[];
	contextState: ContextState;
	/** Only an explicit lifecycle action may shrink task-scoped packs. */
	newTask?: boolean;
}

export type CapabilityReason =
	| "core"
	| "inactive"
	| "posture-required"
	| "explicit-fleet"
	| "explicit-verification"
	| "tier-verification"
	| "explicit-peer"
	| "explicit-workspace"
	| "explicit-compaction"
	| "approaching-compaction"
	| "imminent-compaction"
	| "ambiguous-fleet"
	| "ambiguous-peer"
	| "ambiguous-workspace"
	| "task-retained"
	| "pending-operation";

export interface CapabilityResolution {
	active: CapabilityPack[];
	provisional: CapabilityPack[];
	reasons: Record<CapabilityPack, CapabilityReason>;
	confirmationRequired: CapabilityPack[];
	/** Persist this compact state for the current task; it contains no user text. */
	nextTaskPacks: CapabilityPack[];
}

/** Session-safe capability metadata. It intentionally contains no user message. */
export interface PersistedCapabilityState {
	taskPacks: CapabilityPack[];
	active: CapabilityPack[];
	provisional: CapabilityPack[];
	reasons: Record<CapabilityPack, CapabilityReason>;
	confirmationRequired: CapabilityPack[];
	confirmation: CapabilityConfirmationState;
}

export function persistedCapabilityState(resolution: CapabilityResolution, confirmation: CapabilityConfirmationState = {}): PersistedCapabilityState {
	return {
		taskPacks: resolution.nextTaskPacks,
		active: resolution.active,
		provisional: resolution.provisional,
		reasons: resolution.reasons,
		confirmationRequired: resolution.confirmationRequired,
		confirmation,
	};
}

export function latestPersistedCapabilityState(entries: readonly unknown[]): PersistedCapabilityState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: Partial<PersistedCapabilityState> } | null;
		if (entry?.type !== "custom" || entry.customType !== "agent-hub-capability-packs") continue;
		const data = entry.data;
		if (!data || !Array.isArray(data.taskPacks) || !Array.isArray(data.active) || !Array.isArray(data.provisional) || !Array.isArray(data.confirmationRequired) || !data.reasons) continue;
		const valid = (packs: unknown[]): packs is CapabilityPack[] => packs.every(pack => typeof pack === "string" && CAPABILITY_PACKS.includes(pack as CapabilityPack));
		if (!valid(data.taskPacks) || !valid(data.active) || !valid(data.provisional) || !valid(data.confirmationRequired)) continue;
		return {
			taskPacks: ordered(data.taskPacks), active: ordered(data.active), provisional: ordered(data.provisional),
			reasons: { core: "core", fleet: "inactive", verification: "inactive", peer: "inactive", workspace: "inactive", compaction: "inactive", ...data.reasons },
			confirmationRequired: ordered(data.confirmationRequired),
			confirmation: data.confirmation && typeof data.confirmation === "object" ? data.confirmation as CapabilityConfirmationState : {},
		};
	}
	return null;
}

function matches(text: string, expression: RegExp): boolean {
	return expression.test(text);
}

function isAvailable(pack: CapabilityPack, input: CapabilityResolutionInput): boolean {
	return pack !== "peer" || input.comsReady
		? pack !== "workspace" || input.herdrReady
		: false;
}

/**
 * Resolves semantic operation families locally. The input text is inspected only
 * for this call; no raw text is included in the resolution or persisted state.
 */
function intentFor(text: string): Record<Exclude<CapabilityPack, "core">, boolean> {
	const normalized = text.toLowerCase();
	return {
		fleet: matches(normalized, /\b(dispatch|delegate|delegation|specialist|research(?:\s+helper)?|spawn\s+(?:an?\s+)?agent)\b/),
		verification: matches(normalized, /\b(verification|verify|acceptance\s+(?:criteria|gate|work)|assertions?|parity)\b/),
		peer: matches(normalized, /\b(coms|existing\s+peer|peer\s+(?:message|reply|channel)|message\s+(?:the\s+)?peer)\b/),
		workspace: matches(normalized, /\b(herdr|(?:open|spawn)\s+(?:a\s+)?pane|watcher|notify|notification)\b/),
		compaction: matches(normalized, /\b(compaction|request_compaction|compact\s+(?:the\s+)?(?:context|conversation|session))\b/),
	};
}

function ambiguousPack(text: string, input: CapabilityResolutionInput): CapabilityPack | null {
	const normalized = text.toLowerCase();
	if (input.comsReady && matches(normalized, /\b(contact|message|reach)\s+(them|someone)\b/)) return "peer";
	if (input.herdrReady && matches(normalized, /\b(start|open)\s+(it|something)\s+(somewhere|else)\b/)) return "workspace";
	if (matches(normalized, /\b(somebody|someone|another\s+person)\s+else\s+(?:to\s+)?(?:handle|do|work)\b/)) return "fleet";
	return null;
}

function ordered(packs: Iterable<CapabilityPack>): CapabilityPack[] {
	const set = new Set(packs);
	return CAPABILITY_PACKS.filter(pack => set.has(pack));
}

/** A pure, deterministic resolver for the model-visible capability profile. */
export function resolveCapabilityPacks(input: CapabilityResolutionInput): CapabilityResolution {
	const intent = intentFor(input.userText);
	const active = new Set<CapabilityPack>(["core"]);
	const provisional = new Set<CapabilityPack>();
	const reasons: Record<CapabilityPack, CapabilityReason> = {
		core: "core", fleet: "inactive", verification: "inactive", peer: "inactive", workspace: "inactive", compaction: "inactive",
	};
	const activate = (pack: CapabilityPack, reason: CapabilityReason) => {
		if (!isAvailable(pack, input)) return;
		active.add(pack);
		reasons[pack] = reason;
	};

	if (!input.newTask) {
		for (const pack of input.taskPacks) {
			if (pack !== "core" && pack !== "compaction") activate(pack, "task-retained");
		}
		for (const pack of input.provisionalPacks ?? []) {
			if (pack !== "core" && pack !== "compaction" && isAvailable(pack, input)) {
				provisional.add(pack);
				reasons[pack] = `ambiguous-${pack}` as CapabilityReason;
			}
		}
	}
	for (const operation of input.pendingOperations) activate(operation.pack, "pending-operation");

	if (input.posture === "orchestrator") activate("fleet", "posture-required");
	if (intent.fleet) activate("fleet", "explicit-fleet");
	if (intent.verification) activate("verification", "explicit-verification");
	if (input.taskTier === "feature" || input.taskTier === "project") activate("verification", "tier-verification");
	if (intent.peer) activate("peer", "explicit-peer");
	if (intent.workspace) activate("workspace", "explicit-workspace");
	if (intent.compaction) activate("compaction", "explicit-compaction");
	if (input.contextState === "approaching-compaction") activate("compaction", "approaching-compaction");
	if (input.contextState === "imminent-compaction") activate("compaction", "imminent-compaction");

	const ambiguous = ambiguousPack(input.userText, input);
	if (ambiguous && !active.has(ambiguous) && isAvailable(ambiguous, input)) {
		provisional.add(ambiguous);
		reasons[ambiguous] = `ambiguous-${ambiguous}` as CapabilityReason;
	}

	const activePacks = ordered(active);
	const provisionalPacks = ordered(provisional);
	const nextTaskPacks = ordered(activePacks.filter(pack => pack !== "core" && pack !== "compaction"));
	return { active: activePacks, provisional: provisionalPacks, reasons, confirmationRequired: provisionalPacks, nextTaskPacks };
}
