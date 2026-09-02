import { readFileSync } from "node:fs";
import { StartRefusedError } from "./git.ts";

interface ScannedPersona {
	name: string; description: string; tools: string; model?: string; models?: string[];
	thinking?: string; systemPrompt: string; file: string;
}
const agentsModulePath: string = "../../../.pi/harnesses/agent-hub/config/agents.ts";
const { scanAgentDirs } = await import(agentsModulePath) as { scanAgentDirs(cwd: string): ScannedPersona[] };
export type PersonaDefinition = ScannedPersona & { fallbackModel?: string; writes?: string[] };

function declaredWrites(file: string): string[] | undefined {
	const frontmatter = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const lines = frontmatter.split("\n");
	const index = lines.findIndex(line => /^writes\s*:/.test(line));
	if (index < 0) return undefined;
	const inline = lines[index].replace(/^writes\s*:\s*/, "").trim();
	if (inline === "[]") return [];
	if (inline) return inline.replace(/^\[|\]$/g, "").split(",").map(value => value.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
	const values: string[] = [];
	for (let i = index + 1; i < lines.length; i++) {
		const match = lines[i].match(/^\s+-\s+(.+)$/);
		if (!match) break;
		values.push(match[1].trim().replace(/^['\"]|['\"]$/g, ""));
	}
	return values;
}

export function listPersonas(cwd = process.cwd()): PersonaDefinition[] {
	return scanAgentDirs(cwd).map(def => {
		const override = process.env[`AGENT_FLEET_MODEL_${def.name.toUpperCase().replace(/-/g, "_")}`];
		const model = override || def.model || def.models?.[0];
		const fallbackModel = [def.model, ...(def.models ?? [])].find(candidate => candidate && candidate !== model);
		const writes = declaredWrites(def.file);
		return { ...def, model, fallbackModel, ...(writes === undefined ? {} : { writes }) };
	});
}

export function resolvePersona(name: string, cwd = process.cwd()): PersonaDefinition {
	const persona = listPersonas(cwd).find(def => def.name.toLowerCase() === name.toLowerCase());
	if (!persona) throw new StartRefusedError(`Flow start refused: persona "${name}" was not found in agents/, .claude/agents/, or .pi/agents/.`);
	if (!persona.model) throw new StartRefusedError(`Flow start refused: persona "${name}" declares no model.`);
	return persona;
}
