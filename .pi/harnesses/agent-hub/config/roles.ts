// roles.ts — the three runtime roles and the assignment resolver.
//
// A role is a capability ceiling, not a persona. The Hub dispatches only
// `researcher`, `reviewer` and `editor`; a workspace file with the same name may
// replace the prompt or model, but tools, read-only status and kind come from
// the code-owned record below. Practices (practices.ts) add method and expected
// evidence to an assignment and never widen it.

import { basePersonaName } from "../run-budget.js";
import { intersectToolLists } from "../helpers.ts";
import type { AgentDef } from "../types.ts";
import {
	DECISION_QUESTION_GUIDANCE,
	isPracticeId,
	normalizePracticeInput,
	PRACTICE_IDS,
	PRACTICES,
	practiceSkillPaths,
	type PracticeId,
	type PracticeRecord,
	type ResolvedSkill,
} from "./practices.ts";

export type RoleName = "researcher" | "reviewer" | "editor";

export const ROLE_NAMES: readonly RoleName[] = Object.freeze(["researcher", "reviewer", "editor"]);

export interface RoleRecord {
	readonly name: RoleName;
	readonly summary: string;
	readonly readOnly: boolean;
	/** Highest tool set a definition may declare; null leaves the declared list as is. */
	readonly toolCeiling: string | null;
	readonly defaultTools: string;
	readonly kind?: "research";
	/** Applied when an assignment names no practice, and recorded as a default. */
	readonly defaultPractices: readonly PracticeId[];
}

export const ROLES: Readonly<Record<RoleName, RoleRecord>> = Object.freeze({
	researcher: Object.freeze({
		name: "researcher",
		summary: "Read-only investigation that returns sources, uncertainty and remaining questions.",
		readOnly: true,
		toolCeiling: "read,grep,find,ls",
		defaultTools: "read,grep,find,ls",
		kind: "research",
		defaultPractices: Object.freeze(["research"] as PracticeId[]),
	}),
	reviewer: Object.freeze({
		name: "reviewer",
		summary: "Read-only, independent assessment of a named plan, code change or documentation revision.",
		readOnly: true,
		// bash is reachable only in an explicit active-check mode under the
		// write-denying sandbox (dispatch-access.ts); inspection strips it.
		toolCeiling: "read,bash,grep,find,ls",
		defaultTools: "read,bash,grep,find,ls",
		defaultPractices: Object.freeze(["independent-review"] as PracticeId[]),
	}),
	editor: Object.freeze({
		name: "editor",
		summary: "Creates or changes code, tests, plans and documentation within the authorized write scope.",
		readOnly: false,
		toolCeiling: null,
		defaultTools: "read,write,edit,bash,grep,find,ls",
		defaultPractices: Object.freeze(["implementation"] as PracticeId[]),
	}),
});

export function isRoleName(value: string): value is RoleName {
	return (ROLE_NAMES as readonly string[]).includes(value);
}

/** The role of an agent key, including a parallel instance (`editor--p2`). */
export function roleOf(agent: string | undefined | null): RoleName | null {
	const base = basePersonaName(agent ?? "");
	return isRoleName(base) ? base : null;
}

export const isReviewerRole = (agent: string | undefined | null): boolean => roleOf(agent) === "reviewer";
export const isResearcherRole = (agent: string | undefined | null): boolean => roleOf(agent) === "researcher";
export const isEditorRole = (agent: string | undefined | null): boolean => roleOf(agent) === "editor";

// ── Retired personas ─────────────────────────────────────────────────────────

export interface RetiredAssignment {
	readonly role: RoleName;
	readonly practices: readonly PracticeId[];
	readonly outcome: string;
}

const retired = (...assignments: RetiredAssignment[]): readonly RetiredAssignment[] => Object.freeze(assignments.map(entry => Object.freeze({ ...entry, practices: Object.freeze([...entry.practices]) })));

/** The migration table of the plan: the outcome decides the role where a persona combined inspection and editing. */
export const RETIRED_PERSONAS: Readonly<Record<string, readonly RetiredAssignment[]>> = Object.freeze({
	architect: retired(
		{ role: "researcher", practices: ["architecture"], outcome: "analysis" },
		{ role: "editor", practices: ["architecture", "documentation"], outcome: "an ADR" },
	),
	bowser: retired(
		{ role: "researcher", practices: ["browser-debugging"], outcome: "observation" },
		{ role: "editor", practices: ["browser-debugging"], outcome: "authorized stateful interaction or test artifacts" },
	),
	builder: retired({ role: "editor", practices: ["implementation"], outcome: "implementation; add testing as needed" }),
	"code-reviewer": retired({ role: "reviewer", practices: ["independent-review"], outcome: "review of code or documentation" }),
	"deep-researcher": retired({ role: "researcher", practices: ["research"], outcome: "research; the question drives the depth" }),
	documenter: retired({ role: "editor", practices: ["documentation"], outcome: "documentation" }),
	"plan-reviewer": retired({ role: "reviewer", practices: ["independent-review"], outcome: "plan review; add architecture or planning as needed" }),
	planner: retired(
		{ role: "editor", practices: ["planning"], outcome: "a saved plan" },
		{ role: "researcher", practices: ["planning"], outcome: "advice" },
	),
	releaser: retired({ role: "editor", practices: ["release"], outcome: "scoped release preparation; publishing needs separate explicit permission" }),
	"security-auditor": retired(
		{ role: "reviewer", practices: ["independent-review", "security"], outcome: "a security review" },
		{ role: "editor", practices: ["security"], outcome: "fixes" },
	),
	"test-engineer": retired(
		{ role: "editor", practices: ["testing"], outcome: "test changes" },
		{ role: "reviewer", practices: ["testing", "independent-review"], outcome: "coverage assessment" },
	),
	"web-debugger": retired(
		{ role: "researcher", practices: ["browser-debugging"], outcome: "diagnosis" },
		{ role: "editor", practices: ["browser-debugging"], outcome: "scoped changes" },
	),
	"web-performance-auditor": retired(
		{ role: "reviewer", practices: ["performance", "independent-review"], outcome: "a performance audit" },
		{ role: "editor", practices: ["performance"], outcome: "measurement requiring writes or optimization work" },
	),
});

export function retiredAssignments(agent: string): readonly RetiredAssignment[] | null {
	return RETIRED_PERSONAS[basePersonaName(agent)] ?? null;
}

export function formatRetiredMapping(assignments: readonly RetiredAssignment[]): string {
	return assignments
		.map(entry => `agent "${entry.role}" with practices [${entry.practices.map(id => `"${id}"`).join(", ")}] for ${entry.outcome}`)
		.join("; or ");
}

/** Null when `agent` is not a retired persona name. */
export function retiredPersonaDiagnostic(agent: string): string | null {
	const assignments = retiredAssignments(agent);
	if (!assignments) return null;
	return `"${basePersonaName(agent)}" is a retired persona and is no longer dispatched. Dispatch a role with practices instead: ${formatRetiredMapping(assignments)}.`;
}

// ── Role definitions ─────────────────────────────────────────────────────────

/** Apply the code-owned ceiling to a definition file: prompt, model and helpers stay, authority does not. */
export function applyRoleCeiling<T extends AgentDef>(def: T): T {
	const role = roleOf(def.name);
	if (!role) return def;
	const record = ROLES[role];
	const declared = def.toolsExplicit ? def.tools : record.defaultTools;
	const tools = record.toolCeiling ? intersectToolLists(declared, record.toolCeiling) : declared;
	const next: T = { ...def, name: role, tools: tools || intersectToolLists(record.defaultTools, record.toolCeiling ?? record.defaultTools) };
	if (record.readOnly) next.readOnly = true;
	else delete next.readOnly;
	if (record.kind) next.kind = record.kind;
	else delete next.kind;
	return next;
}

export interface IgnoredDefinition {
	readonly name: string;
	readonly file: string;
	readonly reason: string;
}

export interface RoleDefinitionSelection<T extends AgentDef> {
	readonly roles: T[];
	readonly ignored: IgnoredDefinition[];
	readonly missing: RoleName[];
}

/**
 * Keep only the three role definitions (first by persona-directory precedence)
 * and apply their ceilings. Every other definition is reported, never loaded.
 */
export function selectRoleDefinitions<T extends AgentDef>(defs: readonly T[]): RoleDefinitionSelection<T> {
	const roles: T[] = [];
	const ignored: IgnoredDefinition[] = [];
	const seen = new Set<RoleName>();
	for (const def of defs) {
		const name = def.name.toLowerCase();
		if (isRoleName(name) && !seen.has(name)) {
			seen.add(name);
			roles.push(applyRoleCeiling({ ...def, name }));
			continue;
		}
		const retiredHint = retiredPersonaDiagnostic(name);
		ignored.push(Object.freeze({
			name,
			file: def.file,
			reason: retiredHint ?? `only the roles ${ROLE_NAMES.join(", ")} are dispatched; a file with a role's name may replace its prompt or model`,
		}));
	}
	return { roles, ignored, missing: ROLE_NAMES.filter(role => !seen.has(role)) };
}

/** One startup warning for ignored agent files and missing roles; null when there is nothing to say. */
export function roleDefinitionNotice(ignored: readonly IgnoredDefinition[], missing: readonly RoleName[]): string | null {
	const lines: string[] = [];
	if (missing.length) lines.push(`Missing role definition${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} — run agent-fleet setup to install ${missing.length > 1 ? "them" : "it"}; dispatches to ${missing.length > 1 ? "these roles" : "it"} are refused.`);
	if (ignored.length) {
		lines.push(`Not dispatched (only ${ROLE_NAMES.join(", ")} are roles):`);
		for (const entry of ignored.slice(0, 12)) lines.push(`- ${entry.file}: ${entry.reason}`);
		if (ignored.length > 12) lines.push(`- … and ${ignored.length - 12} more`);
	}
	return lines.length ? lines.join("\n") : null;
}

// ── Assignment resolution ────────────────────────────────────────────────────

export interface ResolvedPractice {
	readonly practice: PracticeRecord;
	readonly skills: readonly ResolvedSkill[];
}

export interface ResolvedAssignment {
	readonly ok: true;
	readonly role: RoleName;
	/** Agent key as dispatched, e.g. `editor--p2`. */
	readonly agent: string;
	readonly practices: readonly ResolvedPractice[];
	/** True when the role's defaults filled an empty practice list. */
	readonly defaulted: boolean;
	readonly expectedResult: readonly string[];
	readonly missingSkills: readonly string[];
}

export interface AssignmentRefusal {
	readonly ok: false;
	readonly reason: "retired_persona" | "unknown_role" | "unknown_practice" | "incompatible_practice";
	readonly message: string;
}

export type AssignmentResolution = ResolvedAssignment | AssignmentRefusal;

const practiceList = `Known practices: ${PRACTICE_IDS.join(", ")}.`;

export function resolveAssignment(input: { agent: string; practices?: readonly string[] | null }, skillRoots: readonly string[]): AssignmentResolution {
	const agent = String(input.agent ?? "").trim().toLowerCase();
	const role = roleOf(agent);
	if (!role) {
		const retiredHint = retiredPersonaDiagnostic(agent);
		if (retiredHint) return { ok: false, reason: "retired_persona", message: retiredHint };
		return { ok: false, reason: "unknown_role", message: `Unknown role "${agent}". Dispatch one of: ${ROLE_NAMES.join(", ")}, and attach practices. ${practiceList}` };
	}
	const requested = (input.practices ?? []).map(normalizePracticeInput).filter(Boolean);
	const unknown = requested.filter(id => !isPracticeId(id));
	if (unknown.length) {
		return { ok: false, reason: "unknown_practice", message: `Unknown practice${unknown.length > 1 ? "s" : ""} ${unknown.map(id => `"${id}"`).join(", ")}. ${practiceList}` };
	}
	const defaulted = requested.length === 0;
	const ids = [...new Set(defaulted ? ROLES[role].defaultPractices : requested as PracticeId[])];
	const incompatible = ids.filter(id => !PRACTICES[id].roles.includes(role));
	if (incompatible.length) {
		const owners = incompatible.map(id => `"${id}" needs ${PRACTICES[id].roles.join(" or ")}`).join("; ");
		return { ok: false, reason: "incompatible_practice", message: `Practice not available to ${role}: ${owners}. A practice never widens a role; dispatch the role it needs.` };
	}
	const practices = ids.map(id => Object.freeze({ practice: PRACTICES[id], skills: Object.freeze(practiceSkillPaths(PRACTICES[id], skillRoots)) }));
	return Object.freeze({
		ok: true as const,
		role,
		agent,
		practices: Object.freeze(practices),
		defaulted,
		expectedResult: Object.freeze(practices.map(entry => entry.practice.result)),
		missingSkills: Object.freeze([...new Set(practices.flatMap(entry => entry.skills.filter(skill => !skill.path).map(skill => skill.name)))]),
	});
}

export function assignmentPracticeIds(assignment: ResolvedAssignment): PracticeId[] {
	return assignment.practices.map(entry => entry.practice.id);
}

export function assignmentSkillPaths(assignment: ResolvedAssignment): string[] {
	return [...new Set(assignment.practices.flatMap(entry => entry.skills.map(skill => skill.path).filter((path): path is string => Boolean(path))))];
}

/** The assignment block every route (native, research, coms) carries to the worker. */
export function formatAssignmentBlock(assignment: ResolvedAssignment): string {
	const lines = [
		"## Assignment",
		`Role: ${assignment.role} — ${ROLES[assignment.role].summary}`,
		`Practices: ${assignment.practices.map(entry => entry.practice.title).join(", ")}${assignment.defaulted ? " (role default)" : ""}.`,
		"A practice supplies method and expected evidence. It never adds authority: the role ceiling, the authorized scope and the runtime decide what you may do.",
	];
	for (const { practice, skills } of assignment.practices) {
		lines.push("", `### ${practice.title}`, `Expected result: ${practice.result}`, practice.method);
		const found = skills.filter(skill => skill.path).map(skill => skill.path as string);
		const missing = skills.filter(skill => !skill.path).map(skill => skill.name);
		if (found.length) lines.push(`Read before starting: ${found.join(", ")}`);
		if (missing.length) lines.push(`Not installed (use the method above): ${missing.join(", ")}`);
		if (practice.decisions) lines.push(`Decision questions: ${practice.decisions}`);
	}
	if (assignment.practices.some(entry => entry.practice.decisions)) lines.push("", DECISION_QUESTION_GUIDANCE);
	return lines.join("\n");
}

/**
 * Order-free practice identity of an assignment, with the role default filled in, for
 * contract keys (no-progress, review reuse). One role with different practices is a
 * different attempt, as two personas were before.
 */
export function assignmentPracticeKey(agent: string, practices: readonly string[] | null | undefined): string[] {
	const requested = (practices ?? []).map(normalizePracticeInput).filter(Boolean);
	const role = roleOf(agent);
	const ids = requested.length ? requested : role ? [...ROLES[role].defaultPractices] : [];
	return [...new Set(ids)].sort();
}

/** Compact trace label, e.g. `editor[planning,implementation]`. */
export function assignmentLabel(assignment: ResolvedAssignment): string {
	return `${assignment.agent}[${assignmentPracticeIds(assignment).join(",")}]`;
}
