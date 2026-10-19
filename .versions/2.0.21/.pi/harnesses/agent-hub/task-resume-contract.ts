import { posix } from "node:path";

export interface TaskResumeInput {
	taskId: string;
	instructions: string;
	scope?: readonly string[];
	deliverables?: readonly string[];
	artifacts?: readonly string[];
	model?: string | null;
	permissions?: readonly string[] | string;
	previous?: TaskResumeContract | null;
}

export interface TaskResumeContract {
	taskId: string;
	instructions: string;
	scope: string[];
	deliverables: string[];
	artifacts: string[];
	model: string | null;
	permissions: string[];
	resumeAllowed: boolean;
	inheritedUnfinishedInstructions: boolean;
	identity: string;
}

function normalizeText(value: unknown): string {
	return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeList(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map(value => posix.normalize(String(value).trim().replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean))].sort();
}

function normalizePermissions(value: readonly string[] | string | undefined): string[] {
	return normalizeList(typeof value === "string" ? value.split(",") : value);
}

function identityOf(contract: Omit<TaskResumeContract, "resumeAllowed" | "inheritedUnfinishedInstructions" | "identity">): string {
	return JSON.stringify([
		contract.taskId,
		contract.instructions,
		contract.scope,
		contract.deliverables,
		contract.artifacts,
		contract.model,
		contract.permissions,
	]);
}

/** Bind Pi session reuse to the exact current task and capability contract. */
export function bindResume(input: TaskResumeInput): TaskResumeContract {
	const current = {
		taskId: normalizeText(input.taskId),
		instructions: normalizeText(input.instructions),
		scope: normalizeList(input.scope),
		deliverables: normalizeList(input.deliverables),
		artifacts: normalizeList(input.artifacts),
		model: normalizeText(input.model) || null,
		permissions: normalizePermissions(input.permissions),
	};
	const identity = identityOf(current);
	const resumeAllowed = !!input.previous && input.previous.identity === identity;
	return {
		...current,
		resumeAllowed,
		inheritedUnfinishedInstructions: resumeAllowed,
		identity,
	};
}
