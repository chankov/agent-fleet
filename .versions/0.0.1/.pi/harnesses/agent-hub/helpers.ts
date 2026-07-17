import { isAbsolute, relative, resolve } from "node:path";

export const MAX_DELEGATE_DEPTH = 1;
export const DELEGATE_TREE_SPAWN_BUDGET = 4;
export const READ_ONLY_TOOLS = "read,grep,find,ls";

const SAFE_AGENT_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const teamMatch = line.match(/^(\S[^:]*):\s*$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

export function safeAgentKey(value: string): string {
	if (typeof value !== "string") {
		throw new Error("Agent key must be a string");
	}
	const key = value.trim();
	if (!SAFE_AGENT_KEY_RE.test(key)) {
		throw new Error(`Invalid agent key "${value}"; expected a lowercase slug (a-z, 0-9, hyphen)`);
	}
	return key;
}

export function safePathWithin(baseDir: string, ...segments: string[]): string {
	const base = resolve(baseDir);
	const target = resolve(base, ...segments);
	const rel = relative(base, target);
	if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
		throw new Error(`Refusing path outside ${base}: ${target}`);
	}
	return target;
}

export function clampDelegateDepth(depth: number): number {
	return Math.min(Math.max(0, Math.floor(depth)), MAX_DELEGATE_DEPTH);
}

function positiveBudget(value: unknown, fallback: number): number {
	const safeFallback = Math.min(Math.max(1, Math.floor(fallback)), DELEGATE_TREE_SPAWN_BUDGET);
	const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? Math.min(n, DELEGATE_TREE_SPAWN_BUDGET) : safeFallback;
}

function remainingBudget(value: unknown, fallback: number): number {
	const safeFallback = Math.min(Math.max(0, Math.floor(fallback)), DELEGATE_TREE_SPAWN_BUDGET);
	const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
	return Number.isFinite(n) && n >= 0 ? Math.min(n, DELEGATE_TREE_SPAWN_BUDGET) : safeFallback;
}

export interface DelegateBudgetState {
	depth: number;
	callBudget: number;
	remainingSpawns: number;
}

export function normalizeDelegateRuntimeBudgets(
	input: { depth?: unknown; callBudget?: unknown; remainingSpawns?: unknown },
	fallbackCallBudget = DELEGATE_TREE_SPAWN_BUDGET,
): DelegateBudgetState {
	const callBudget = positiveBudget(input.callBudget, fallbackCallBudget);
	return {
		depth: typeof input.depth === "number" ? clampDelegateDepth(input.depth) : 0,
		callBudget,
		remainingSpawns: remainingBudget(input.remainingSpawns, callBudget),
	};
}

export function delegateBudgetRefusal(state: DelegateBudgetState & { callCount: number }): string | null {
	if (state.depth <= 0) {
		return "Delegation refused: your depth budget is 0 — you are already at the bottom of the " +
			"delegation tree. Do this task yourself with your own tools.";
	}
	if (state.remainingSpawns <= 0) {
		return `Delegation refused: tree-wide spawn budget exhausted (${DELEGATE_TREE_SPAWN_BUDGET} ` +
			"delegate children per dispatch). Finish with the results you already have.";
	}
	if (state.callCount >= state.callBudget) {
		return `Delegation refused: process call budget exhausted (${state.callBudget} delegate calls). ` +
			"Finish with the results you already have.";
	}
	return null;
}

export function intersectToolLists(base: string, cap: string): string {
	const baseSet = new Set(base.split(",").map(s => s.trim()).filter(Boolean));
	return cap.split(",").map(s => s.trim()).filter(t => t && baseSet.has(t)).join(",");
}

export interface DelegateToolResolution {
	baseTools: string;
	effectiveTools: string;
	writeDowngraded: boolean;
	refused: boolean;
}

export function resolveDelegateTools(input: {
	parentTools: string;
	roleTools?: string;
	allowWrite?: boolean;
	concurrent?: boolean;
}): DelegateToolResolution {
	const writeDowngraded = input.allowWrite === true && input.concurrent === true;
	const baseTools = input.allowWrite === true && input.concurrent !== true ? input.parentTools : READ_ONLY_TOOLS;
	const effectiveTools = input.roleTools ? intersectToolLists(baseTools, input.roleTools) : baseTools;
	return {
		baseTools,
		effectiveTools,
		writeDowngraded,
		refused: effectiveTools.length === 0,
	};
}

export interface DelegateSpawnPlan {
	childId: string;
	nextRemainingSpawns: number;
	childDepth: number;
	childRemainingSpawns: number;
	childCanDelegate: boolean;
	childExtensions: string[];
	childTools: string;
	includeDelegateConfig: boolean;
}

export function planDelegateSpawn(input: {
	tag: string;
	roleKey: string;
	childSeq: number;
	depth: number;
	remainingSpawns: number;
	effectiveTools: string;
	damageControl?: string;
	delegateExt: string;
}): DelegateSpawnPlan {
	const nextRemainingSpawns = Math.max(0, input.remainingSpawns - 1);
	const childDepth = input.depth - 1;
	const childCanDelegate = childDepth > 0 && nextRemainingSpawns > 0;
	return {
		childId: input.tag === "root" ? `${input.roleKey}-${input.childSeq}` : `${input.tag}.${input.roleKey}-${input.childSeq}`,
		nextRemainingSpawns,
		childDepth,
		childRemainingSpawns: nextRemainingSpawns,
		childCanDelegate,
		childExtensions: [
			...(input.damageControl ? [input.damageControl] : []),
			...(childCanDelegate ? [input.delegateExt] : []),
		],
		childTools: childCanDelegate ? `${input.effectiveTools},delegate` : input.effectiveTools,
		includeDelegateConfig: childCanDelegate,
	};
}
