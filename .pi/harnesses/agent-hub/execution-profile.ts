import { orchestratorNeedsRoster } from "./helpers.ts";
import { parsePosture, POSTURES, type Posture } from "./posture.ts";
import { HUB_MODES, normalizeHubMode } from "./run-budget.js";

export type HubMode = "fast" | "standard" | "strict";
export type ExecutionPair = { mode: HubMode; posture: Posture };

export interface RecommendedProfile extends ExecutionPair {
	id: HubMode;
	label: string;
	description: string;
}

export const RECOMMENDED_PROFILES: readonly RecommendedProfile[] = [
	{
		id: "fast",
		label: "Fast Operator",
		mode: "fast",
		posture: "operator",
		description: "Direct work; smallest fleet budget",
	},
	{
		id: "standard",
		label: "Standard Orchestrator",
		mode: "standard",
		posture: "orchestrator",
		description: "Delegated work; balanced verification",
	},
	{
		id: "strict",
		label: "Strict Orchestrator",
		mode: "strict",
		posture: "orchestrator",
		description: "Delegated work; full Verification Contract",
	},
];

export const ALL_EXECUTION_PAIRS: readonly ExecutionPair[] = HUB_MODES.filter(isHubMode).flatMap(mode =>
	POSTURES.map(posture => ({ mode, posture })),
);

const HUB_MODE_SUMMARIES: Record<HubMode, string> = {
	fast: "single specialist; smallest fleet budget",
	standard: "batched execution; balanced verification",
	strict: "full Verification Contract",
};

export type WorkModeParse =
	| { ok: true; action: "picker" }
	| { ok: true; action: "advanced" }
	| { ok: true; action: "apply"; pair: ExecutionPair }
	| { ok: false; error: string };

export type ExecutionProfileClass =
	| { kind: "recommended"; id: HubMode; label: string; pair: ExecutionPair }
	| { kind: "custom"; label: string; pair: ExecutionPair };

function titleCase(value: string): string {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return "";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function formatPickerOption(selected: boolean, label: string, description: string): string {
	return `${selected ? "✓ " : "  "}${label} — ${description}`;
}

function pairDescription(pair: ExecutionPair): string {
	const work = pair.posture === "operator" ? "Direct work" : "Delegated work";
	if (pair.mode === "fast") return `${work}; smallest fleet budget`;
	if (pair.mode === "standard") return `${work}; balanced verification`;
	return `${work}; full Verification Contract`;
}

export function isHubMode(value: unknown): value is HubMode {
	return typeof value === "string" && HUB_MODES.includes(value);
}

export function compactExecutionPair(mode: string, posture: string): string {
	const modeLabel = titleCase(mode) || "Mode";
	const postureLabel = titleCase(posture) || "Posture";
	return `${modeLabel}·${postureLabel}`;
}

export function classifyExecutionProfile(pair: ExecutionPair): ExecutionProfileClass {
	const recommended = RECOMMENDED_PROFILES.find(profile => profile.mode === pair.mode && profile.posture === pair.posture);
	if (recommended) {
		return { kind: "recommended", id: recommended.id, label: recommended.label, pair };
	}
	return { kind: "custom", label: `${titleCase(pair.mode)} ${titleCase(pair.posture)}`, pair };
}

export function executionProfileLabel(pair: ExecutionPair): string {
	return classifyExecutionProfile(pair).label;
}

export function recommendedProfileById(id: string): RecommendedProfile | null {
	return RECOMMENDED_PROFILES.find(profile => profile.id === id) ?? null;
}

export function executionPairBlockedByRoster(current: ExecutionPair, next: ExecutionPair, rosterSize: number): boolean {
	if (next.posture === current.posture) return false;
	return orchestratorNeedsRoster(next.posture, rosterSize);
}

export function parseWorkModeArgs(args: string | undefined | null): WorkModeParse {
	const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, action: "picker" };
	if (tokens.length === 1) {
		const token = tokens[0].toLowerCase();
		if (token === "advanced") return { ok: true, action: "advanced" };
		const recommended = recommendedProfileById(token);
		if (recommended) return { ok: true, action: "apply", pair: { mode: recommended.mode, posture: recommended.posture } };
		return {
			ok: false,
			error: `Unknown work mode "${tokens[0]}" — expected fast, standard, strict, advanced, or "<mode> <posture>".`,
		};
	}
	if (tokens.length === 2) {
		const mode = normalizeHubMode(tokens[0]);
		const posture = parsePosture(tokens[1]);
		if (isHubMode(mode) && posture) {
			return { ok: true, action: "apply", pair: { mode, posture } };
		}
		return {
			ok: false,
			error: `Unknown work mode "${tokens.join(" ")}" — expected fast|standard|strict plus operator|orchestrator.`,
		};
	}
	return {
		ok: false,
		error: `Unknown work mode "${tokens.join(" ")}" — expected fast, standard, strict, advanced, or "<mode> <posture>".`,
	};
}

export function recommendedProfileOptions(current: ExecutionPair): {
	title: string;
	options: string[];
	keys: Array<"fast" | "standard" | "strict" | "advanced">;
} {
	const classified = classifyExecutionProfile(current);
	const options = RECOMMENDED_PROFILES.map(profile => formatPickerOption(
		classified.kind === "recommended" && classified.id === profile.id,
		profile.label,
		profile.description,
	));
	const advancedLabel = classified.kind === "custom"
		? `Advanced… (${compactExecutionPair(current.mode, current.posture)})`
		: "Advanced…";
	options.push(formatPickerOption(false, advancedLabel, "Choose any mode/posture combination"));
	return {
		title: "Execution profile — Alt+M",
		options,
		keys: ["fast", "standard", "strict", "advanced"],
	};
}

export function advancedProfileOptions(current: ExecutionPair): { title: string; options: string[]; pairs: ExecutionPair[] } {
	const pairs = ALL_EXECUTION_PAIRS.map(pair => ({ ...pair }));
	const options = pairs.map(pair => formatPickerOption(
		pair.mode === current.mode && pair.posture === current.posture,
		executionProfileLabel(pair),
		pairDescription(pair),
	));
	return { title: "Advanced execution profile", options, pairs };
}

export function hubModePickerOptions(currentMode: string): { title: string; options: string[]; modes: HubMode[] } {
	const modes = HUB_MODES.filter(isHubMode);
	const options = modes.map(mode => formatPickerOption(mode === currentMode, mode, HUB_MODE_SUMMARIES[mode]));
	return { title: `Execution mode — current ${currentMode}`, options, modes };
}

export function posturePickerOptions(current: Posture): { title: string; options: string[]; postures: Posture[] } {
	const postures = [...POSTURES];
	const options = postures.map(posture => formatPickerOption(
		posture === current,
		posture,
		posture === "operator" ? "Direct tools enabled" : "Delegate-only; requires a native roster",
	));
	return { title: `Fleet posture — current ${current}`, options, postures };
}

export function selectedPickerValue<T>(options: readonly string[], choice: string | undefined, values: readonly T[]): T | undefined {
	if (choice === undefined) return undefined;
	const index = options.indexOf(choice);
	if (index < 0) return undefined;
	return values[index];
}
