import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Workflow-side reader of the Hub's `## agent-hub` / `## agent-team` rules and docs contract. */
export function readProjectPolicy(cwd: string): { rulesPaths: string[]; docsPaths: string[] } {
	const file = join(cwd, ".ai", "agent-fleet-overrides.md");
	if (!existsSync(file)) return { rulesPaths: [], docsPaths: [] };
	let raw: string;
	try { raw = readFileSync(file, "utf8"); } catch { return { rulesPaths: [], docsPaths: [] }; }
	const result = { rulesPaths: [] as string[], docsPaths: [] as string[] };
	let inSection = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) { const name = heading[1].trim().toLowerCase(); inSection = name === "agent-hub" || name === "agent-team"; continue; }
		if (!inSection) continue;
		const pair = line.match(/^\s*([a-zA-Z][\w.-]*)\s*:\s*(.+?)\s*$/);
		if (!pair) continue;
		const key = pair[1].toLowerCase();
		const value = pair[2].trim();
		if (key === "rules" && value) result.rulesPaths = value.split(",").map(s => s.trim()).filter(Boolean);
		if (key === "docs" && value) result.docsPaths = value.split(",").map(s => s.trim()).filter(Boolean);
	}
	return result;
}

export function resolveProjectPolicy(cwd: string, options: { rulesPaths?: string[]; docsPaths?: string[] } = {}, warn: (message: string) => void = console.warn): { rulesPaths: string[]; docsPaths: string[] } {
	const configured = readProjectPolicy(cwd);
	const rulesPaths = [...new Set([...configured.rulesPaths, ...(options.rulesPaths ?? [])])];
	const docsPaths = [...new Set([...configured.docsPaths, ...(options.docsPaths ?? [])])];
	for (const path of rulesPaths) if (!existsSync(join(cwd, path))) warn(`agent-fleet-overrides: rules folder "${path}" not found in ${cwd}`);
	for (const path of docsPaths) if (!existsSync(join(cwd, path))) warn(`agent-fleet-overrides: docs entry point "${path}" not found in ${cwd}`);
	return { rulesPaths, docsPaths };
}
