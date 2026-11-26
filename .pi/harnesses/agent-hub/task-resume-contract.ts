import type { PrivateConfigBinding } from './private-config-current-state.ts';
import { validateBoundAssertionIds } from "./return-contract.js";
import { posix } from "node:path";

export interface TaskResumeInput {
 readonly declaredChecks?: readonly string[];
 privateConfig?: PrivateConfigBinding;
	taskId: string;
 boundAssertionIds?: readonly string[];
	instructions: string;
	scope?: readonly string[];
	deliverables?: readonly string[];
	artifacts?: readonly string[];
	model?: string | null;
	/**
	 * Assignment practices in order; they select a practice-level model (D9). Not part
	 * of the bound identity: the instructions already carry the assignment block.
	 */
	practices?: readonly string[];
	/** Where the model came from (`role` or `practice:<id>:<tier>`); a record, never identity. */
	modelSource?: string;
	permissions?: readonly string[] | string;
	previous?: TaskResumeContract | null;
}

export interface TaskResumeContract {
 privateConfig?: PrivateConfigBinding;
	taskId: string;
 boundAssertionIds?: readonly string[];
	instructions: string;
	scope: string[];
	deliverables: string[];
	artifacts: string[];
	model: string | null;
	practices?: string[];
	modelSource?: string;
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
  contract.boundAssertionIds,
  ...(contract.privateConfig ? [contract.privateConfig] : []),
	]);
}

/** Bind Pi session reuse to the exact current task and capability contract. */
export function bindResume(input: TaskResumeInput): TaskResumeContract {
	const current = {
  ...(input.privateConfig ? { privateConfig: structuredClone(input.privateConfig) } : {}),
		taskId: normalizeText(input.taskId),
  boundAssertionIds: validateBoundAssertionIds(input.boundAssertionIds),
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
		...(input.practices ? { practices: [...input.practices] } : {}),
		...(input.modelSource ? { modelSource: input.modelSource } : {}),
		resumeAllowed,
		inheritedUnfinishedInstructions: resumeAllowed,
		identity,
	};
}
