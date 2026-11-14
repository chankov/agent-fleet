import { spawnSync } from "node:child_process";

export type VisibilityCheckName = "registered" | "auth" | "child-visible";
export interface ModelCheck {
	model: string;
	ok: boolean;
	failed: VisibilityCheckName[];
	reasons: string[];
}
export interface ChildVisibilityReport { models: ModelCheck[]; diagnostic?: string }
export interface ModelRegistryAuth {
	isRegistered(model: string): boolean;
	hasAuth(model: string): boolean;
}
export type ModelListing = { models?: string[]; diagnostic?: string };
export type ListModels = () => ModelListing;

let listingCache: ModelListing | undefined;

export function resetModelVisibilityCache(): void {
	listingCache = undefined;
}

export function parseListModelsOutput(text: string): string[] {
	const cleaned = text.replace(/\u001B\[[0-9;]*m/g, "");
	const lines = cleaned.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
	if (lines.length === 0) return [];
	const models = new Set<string>();
	for (const line of lines.slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2 || (parts[0] === "provider" && parts[1] === "model")) continue;
		models.add(`${parts[0]}/${parts[1]}`);
	}
	return [...models];
}

export function checkChildVisibility(models: string[], listModels?: ListModels): ChildVisibilityReport {
	const listing = loadListing(listModels);
	if (listing.diagnostic) {
		return {
			diagnostic: listing.diagnostic,
			models: models.map(model => ({
				model, ok: false, failed: [],
				reasons: [`${model}: child-visible check not performed — ${listing.diagnostic}`],
			})),
		};
	}
	const visible = new Set(listing.models ?? []);
	return {
		models: models.map(model => visible.has(model)
			? { model, ok: true, failed: [], reasons: [] }
			: {
				model, ok: false, failed: ["child-visible"],
				reasons: [`${model}: child-visible check failed — not listed by pi --no-extensions --list-models`],
			}),
	};
}

export function checkRegistryAuth(models: string[], registry: ModelRegistryAuth): ModelCheck[] {
	return models.map(model => {
		if (!registry.isRegistered(model)) {
			return {
				model, ok: false, failed: ["registered"],
				reasons: [`${model}: registered check failed — model is not in the pi model registry`],
			};
		}
		if (!registry.hasAuth(model)) {
			return {
				model, ok: false, failed: ["auth"],
				reasons: [`${model}: auth check failed — no configured credentials`],
			};
		}
		return { model, ok: true, failed: [], reasons: [] };
	});
}

function loadListing(listModels?: ListModels): ModelListing {
	if (listingCache) return listingCache;
	try { listingCache = listModels ? listModels() : defaultListModels(); }
	catch (error) { listingCache = { diagnostic: error instanceof Error ? error.message : String(error) }; }
	return listingCache;
}

function defaultListModels(): ModelListing {
	const result = spawnSync("pi", ["--no-extensions", "--list-models"], { encoding: "utf8", timeout: 15_000 });
	if (result.error) return { diagnostic: `pi --no-extensions --list-models failed: ${result.error.message}` };
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
		return { diagnostic: `pi --no-extensions --list-models failed: ${detail}` };
	}
	return { models: parseListModelsOutput(result.stdout) };
}
