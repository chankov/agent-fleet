import { profileAgent, profileFallback, assertProfileModel, readActiveProfile } from './model-profile.ts';
import { readFileSync } from "node:fs";
import { sessionRootsFromEnv } from "../../../../harnesses/lib/workspace-context.ts";
import { StartRefusedError } from "./git.ts";

interface ScannedPersona {
	name: string; description: string; tools: string; model?: string; models?: string[];
	thinking?: string; systemPrompt: string; file: string;
	practiceModels?: Record<string, { model?: string; thinking?: string }>;
}
interface ModelChoice { model?: string; thinking?: string }
type AssignmentResolution =
	| { ok: true; role: FlowRole; practices: readonly { practice: { id: string } }[] }
	| { ok: false; reason: string; message: string };
const agentsModulePath: string = "../../../../../.pi/harnesses/agent-hub/config/agents.ts";
const rolesModulePath: string = "../../../../../.pi/harnesses/agent-hub/config/roles.ts";
const profilesModulePath: string = "../../../../../.pi/harnesses/agent-hub/config/model-profiles.ts";
const { scanAgentDirs } = await import(agentsModulePath) as { scanAgentDirs(cwd: string): ScannedPersona[] };
const { resolveAssignment, formatAssignmentBlock, applyRoleCeiling } = await import(rolesModulePath) as {
	resolveAssignment(input: { agent: string; practices?: readonly string[] }, skillRoots: readonly string[]): AssignmentResolution;
	formatAssignmentBlock(assignment: AssignmentResolution & { ok: true }): string;
	applyRoleCeiling<T extends { name: string; tools: string }>(def: T): T;
};
const { practiceSelection } = await import(profilesModulePath) as { practiceSelection(profile: unknown, role: string, practice: string): ModelChoice | undefined };
export type PersonaDefinition = ScannedPersona & { fallbackModel?: string; writes?: string[] };
export type FlowRole = "researcher" | "reviewer" | "editor";
/** A role definition under its code-owned ceiling, with the practices of one flow phase. */
export type RoleAssignment = PersonaDefinition & { role: FlowRole; practices: string[]; assignment: string; modelSource: string };

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
		const selected=profileAgent(def.name);
		const model = selected?.model || override || def.model || def.models?.[0];
		const fallbackModel = profileFallback([def.model, ...(def.models ?? [])].find(candidate => candidate && candidate !== model));
		const writes = declaredWrites(def.file);
		return { ...def, ...(selected?.thinking?{thinking:selected.thinking}:{}), model, fallbackModel, ...(writes === undefined ? {} : { writes }) };
	});
}

export function resolvePersona(name: string, cwd = process.cwd()): PersonaDefinition {
	const persona = listPersonas(cwd).find(def => def.name.toLowerCase() === name.toLowerCase());
	if (!persona) throw new StartRefusedError(`Flow start refused: persona "${name}" was not found in agents/, .claude/agents/, .pi/agents/personas/, or .pi/agents/.`);
	if (!persona.model) throw new StartRefusedError(`Flow start refused: persona "${name}" declares no model.`);
	return persona;
}

export function resolvePhaseModel(persona: PersonaDefinition, override?: string): string {
	const model = override || persona.model;
	if (!model) throw new StartRefusedError(`Flow start refused: persona "${persona.name}" declares no model.`);
	assertProfileModel(model);
	return model;
}

export function resolvePhaseThinking(persona: PersonaDefinition, override?: string): string {
	return override ?? persona.thinking ?? "medium";
}

/**
 * A flow phase as a role with practices, the same contract the Hub dispatches (PLAN-11-01):
 * the role file under its tool ceiling (a flow may narrow it further, never widen it), and
 * the first practice with a model choice, like the Hub (D9) — an active complete profile's
 * `<role>.<practice>` entry, else the role file's `practice_models:` — then the role model.
 */
export function resolveRole(role: FlowRole, practices: readonly string[], cwd = process.cwd(), options: { tools?: string } = {}): RoleAssignment {
	const base = listPersonas(cwd).find(def => def.name.toLowerCase() === role);
	if (!base) throw new StartRefusedError(`Flow start refused: role "${role}" has no definition in agents/, .claude/agents/, .pi/agents/personas/, or .pi/agents/ (install it with agent-fleet setup).`);
	let resource: string | undefined;
	try { resource = sessionRootsFromEnv()?.resourceRoot; } catch { /* no session binding: the workspace alone */ }
	const assignment = resolveAssignment({ agent: role, practices }, resource && resource !== cwd ? [cwd, resource] : [cwd]);
	if (!assignment.ok) throw new StartRefusedError(`Flow start refused: ${assignment.message}`);
	const ceiled = applyRoleCeiling({ ...base });
	const narrowed = options.tools ? new Set(options.tools.split(",").map(tool => tool.trim())) : null;
	const tools = narrowed ? ceiled.tools.split(",").filter(tool => narrowed.has(tool.trim())).join(",") : ceiled.tools;
	const ids = assignment.practices.map(entry => entry.practice.id);
	const active = readActiveProfile();
	let choice: ModelChoice = { model: base.model, thinking: base.thinking };
	let modelSource = "role";
	for (const id of ids) {
		const entry = active ? practiceSelection(active.profile, role, id) : base.practiceModels?.[id];
		if (!entry?.model && !entry?.thinking) continue;
		choice = { model: entry.model || base.model, thinking: entry.thinking ?? base.thinking };
		modelSource = `practice:${id}:${active ? "profile" : "role-file"}`;
		break;
	}
	if (!choice.model) throw new StartRefusedError(`Flow start refused: role "${role}" declares no model.`);
	const fallbackModel = profileFallback([base.model, ...(base.models ?? [])].find(candidate => candidate && candidate !== choice.model));
	return { ...base, name: role, tools, model: choice.model, ...(choice.thinking ? { thinking: choice.thinking } : {}), fallbackModel, role, practices: ids, assignment: formatAssignmentBlock(assignment), modelSource };
}

/** The phase task with its assignment block, as every Hub route carries it to the worker. */
export function withAssignment(task: string, persona: PersonaDefinition & { assignment?: string }): string {
	return persona.assignment ? `${task}\n\n${persona.assignment}` : task;
}

/** Record which role, practices and model source a phase runs with (D9: the trace says which). */
export function logAssignment(phase: { log(message: string, data?: Record<string, unknown>): void }, persona: PersonaDefinition & Partial<Pick<RoleAssignment, "role" | "practices" | "modelSource">>): void {
	if (!persona.role) return;
	phase.log(`assignment ${persona.role}[${(persona.practices ?? []).join(",")}] · ${persona.model ?? "no model"} (${persona.modelSource ?? "role"})`, { role: persona.role, practices: persona.practices ?? [], model: persona.model, modelSource: persona.modelSource ?? "role" });
}
