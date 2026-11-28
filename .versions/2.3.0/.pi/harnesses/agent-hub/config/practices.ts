// practices.ts — the code-owned catalog of the eleven engineering practices.
//
// A practice supplies method and expected evidence for one assignment. It never
// adds authority: the role ceiling (roles.ts), the authorized task scope, the
// backend and the existing action permissions decide what a worker may do.
// Skills are resolved native-first (docs/UPSTREAM-SKILLS.md): a workspace's own
// `skills/` wins, then installed `.pi/skills/`, then the vendored upstream copy.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DECISION_QUESTION_FORMAT } from "../decision-questions.ts";
import { SYSTEM1_QUESTION_FORMAT } from "../system1-question-format.ts";

export type PracticeRole = "researcher" | "reviewer" | "editor";

export const PRACTICE_IDS = [
	"research",
	"architecture",
	"planning",
	"implementation",
	"independent-review",
	"testing",
	"security",
	"performance",
	"browser-debugging",
	"documentation",
	"release",
] as const;

export type PracticeId = typeof PRACTICE_IDS[number];

export interface PracticeRecord {
	readonly id: PracticeId;
	readonly title: string;
	/** Existing skills, in the order the worker should read them. */
	readonly skills: readonly string[];
	/** What a completed assignment returns. */
	readonly result: string;
	/** Roles the practice is meaningful for. Never a grant: the role ceiling still applies. */
	readonly roles: readonly PracticeRole[];
	/** Method and evidence conventions carried over from the retired persona prompts. */
	readonly method: string;
	/** When this practice should propose a Poll or a Debate to the operator (PLAN-11-01 task 13). */
	readonly decisions?: string;
	/** When an optional Ask System 1 suggestion may help, its typed question, and the next verification (task 18). */
	readonly system1?: string;
}

/**
 * Shared by the research, planning, independent-review and security practices, once per assignment
 * block. Workers suggest; only the parent Hub operator may call an active `ask_system1` (D34–D35).
 */
export const SYSTEM1_QUESTION_GUIDANCE = [
	"### Ask System 1 suggestions",
	"You never call ask_system1; only the parent Hub operator may, at its discretion and only when the tool is active there (shared rule: `references/system1-consultation.md`, installed as `.pi/references/system1-consultation.md`).",
	"When one specific uncertainty over a few named candidates blocks your next step, you may add at most two lines, each one JSON object:",
	SYSTEM1_QUESTION_FORMAT,
	"`input` is exactly the ask_system1 arguments: repo-relative paths or minimal non-secret state, and choice (with an \"other\" or \"unknown\" option), predicate or ordinal questions; never secrets or pasted bodies. Do not wait for an answer: do the verification you named. An answer is advice and never counts as evidence, a verdict, a finding or a decision.",
].join("\n");

/**
 * Shared by the planning, architecture, independent-review and security practices, and added to an
 * assignment block once however many of them it carries. Workers propose; the operator decides (D29–D31).
 */
export const DECISION_QUESTION_GUIDANCE = [
	"### Decision questions",
	"You never start a Poll or a Debate; the operator decides whether to run one (operator guidance: the `debate` skill). A fact is never a decision question: look it up, or report NEEDS_RESEARCH.",
	"When a choice between viable alternatives remains and independent theses (Poll) or a test of a named objection (Debate) could change it, add at most two lines, each one JSON object with evidence as paths:",
	DECISION_QUESTION_FORMAT,
	"A proposal never blocks you: finish the assignment with your own recommendation and its evidence. If your work cannot continue without the decision, also raise ASK_USER and stop before the dependent part.",
].join("\n");

const ALL_ROLES: readonly PracticeRole[] = Object.freeze(["researcher", "reviewer", "editor"]);

const record = (value: PracticeRecord): PracticeRecord => Object.freeze({ ...value, skills: Object.freeze([...value.skills]), roles: Object.freeze([...value.roles]) });

export const PRACTICES: Readonly<Record<PracticeId, PracticeRecord>> = Object.freeze({
	research: record({
		id: "research",
		title: "Research",
		skills: ["source-driven-development", "context-engineering"],
		result: "An answer with traceable sources, stated uncertainty and the remaining questions.",
		roles: ALL_ROLES,
		method: [
			"Start with the smallest search that can answer the question. Deepen it when sources disagree, evidence is missing or the consequences justify corroboration; say which depth you used and why.",
			"Trace call paths and data flow to their ends when behavior spans files. Cite every claim as `path:line` or a URL.",
			"Report gaps and conflicting evidence plainly instead of guessing.",
		].join("\n"),
		system1: "When several candidate files could own an access rule, suggest an ordinal question per candidate file (low, medium or high likelihood of containing the enforcing rule). Next, read the highest-ranked candidate and trace its caller to the enforcing check; continue with the others if the evidence is inconclusive.",
	}),
	architecture: record({
		id: "architecture",
		title: "Architecture",
		skills: ["spec-driven-development", "api-and-interface-design"],
		result: "Options, constraints and an interface decision with the trade-off that decided it.",
		roles: ALL_ROLES,
		method: [
			"Ground every option in the codebase and cite it. Give a concrete recommendation, the runner-up and the one trade-off that separates them.",
			"State the constraints and the interface contract (signatures, formats, compatibility) that independent consumers need.",
			"Flag a question that hides a bigger decision than it appears. A decision significant enough to record becomes an ADR, written only by an editor with the documentation practice.",
		].join("\n"),
		decisions: "Give each trade-off estimate with its assumptions and evidence. Propose a Poll when several designs stay viable; propose a Debate when conflicting assumptions could change the interface or the design choice.",
	}),
	planning: record({
		id: "planning",
		title: "Planning",
		skills: ["planning-and-task-breakdown"],
		result: "Ordered tasks with explicit dependencies and acceptance criteria.",
		roles: ALL_ROLES,
		method: [
			"Size the plan to the request. Order tasks by dependency, give each acceptance criteria, keep each task to about five files, and cite the applicable project rule files in the affected criteria.",
			"An editor saves the plan as one document (alone, or before implementing when the assignment also carries implementation): resolve the directory from `.ai/agent-fleet-overrides.md` → `## planning-and-task-breakdown` → `plan-dir` (default `docs/plans/{area}`) and the name from its `naming` key (default `PLAN-{prd-name}.md`), then end the final response with `PLAN_FILE: <repo-relative path>` on its own line.",
			"A researcher or reviewer returns planning advice or plan critique and writes nothing.",
		].join("\n"),
		system1: "When the first step depends on two unsettled assumptions and either could change the sequence, suggest a choice among the listed dependency IDs: which assumption, if false, would invalidate the first step? Next, inspect that dependency's contract or fixture and validate the assumption before ordering tasks.",
		decisions: "Where several task sequences, scopes or migration paths stay viable, propose a Poll for independent theses. Where a dependency or rollback objection could change the chosen plan, propose a Debate of that objection.",
	}),
	implementation: record({
		id: "implementation",
		title: "Implementation",
		skills: ["incremental-implementation"],
		result: "A scoped change with verification evidence.",
		roles: ["editor"],
		method: [
			"Land the change in small, independently verifiable increments inside the authorized scope. Follow existing patterns and implement against every listed site of a parity or touchpoint inventory.",
			"Run the relevant checks after each increment and name the commands and their results.",
		].join("\n"),
	}),
	"independent-review": record({
		id: "independent-review",
		title: "Independent review",
		skills: ["code-review-and-quality", "orchestration-verification"],
		result: "A plan feasibility, code correctness or documentation accuracy verdict against a named revision.",
		roles: ["reviewer"],
		method: [
			"Name the artifact, the scope and the revision you inspected, including working-tree content where applicable, and what you did not inspect. A verdict covers only that.",
			"Plans: challenge assumptions against the codebase, ordering, hidden dependencies, missing steps and proportionality to the request. Code: correctness, readability, architecture, security, performance and parity across sibling cases. Documentation: accuracy against the code it describes.",
			"Attribute every finding to evidence. The author of the reviewed work is never eligible to approve it.",
		].join("\n"),
		system1: "When several acceptance criteria cite evidence and you are unsure which claim has the weakest support, suggest a choice among the criterion IDs: which claim is least supported by the supplied evidence excerpts? Next, check the original evidence against the named revision yourself; the verdict stays yours.",
		decisions: "For a substantial finding in a plan, code or documentation, propose a Poll for independent judgments tied to the named revision, or a Debate when the remedies are incompatible. Keep the evidence references and any dissent. The verdict stays yours; a proposal never changes or replaces it.",
	}),
	testing: record({
		id: "testing",
		title: "Testing",
		skills: ["test-driven-development"],
		result: "A reproduction, regression coverage or check results.",
		roles: ALL_ROLES,
		method: [
			"Reproduce before fixing: a failing test or a recorded failing command comes first (Prove-It). Cover the regression and its boundary cases.",
			"Report each command with its exact result. An editor changes tests within scope; a reviewer assesses coverage and test quality without editing.",
		].join("\n"),
	}),
	security: record({
		id: "security",
		title: "Security",
		skills: ["security-and-hardening"],
		result: "Findings with evidence, or a scoped remediation with verification.",
		roles: ALL_ROLES,
		method: [
			"Threat-model first: name the trust boundaries and data flows, then check input validation, authorization, secrets handling and dependencies along them.",
			"Each finding carries severity, evidence and the exploit path. Never print secret values. A reviewer recommends fixes; an editor applies a scoped fix and verifies it.",
		].join("\n"),
		system1: "When a request crosses several trust boundaries and the permission check on one data flow is unclear, suggest a choice among the listed flow IDs: which crossing most needs inspection for a missing authorization check? Next, trace that flow from input to destination and verify the effective permissions against code and configuration before recording a finding.",
		decisions: "Establish the risk with evidence first, then compare the plausible mitigations. Propose a Debate when a disputed threat-model assumption or residual risk could change the choice.",
	}),
	performance: record({
		id: "performance",
		title: "Performance",
		skills: ["performance-optimization"],
		result: "Measurements, their interpretation and any verified improvement.",
		roles: ALL_ROLES,
		method: [
			"Measure before claiming. Report the method, environment and numbers, then the interpretation. An improvement counts only with before-and-after measurements.",
			"Never invent a metric. Label lab data and field data, and mark a finding from static analysis as potential impact until it is measured.",
			"Measurement that needs writes, a running server or an optimization change belongs to an authorized editor.",
		].join("\n"),
	}),
	"browser-debugging": record({
		id: "browser-debugging",
		title: "Browser automation and interactive debugging",
		skills: ["browser-testing-with-devtools", "debugging-and-error-recovery"],
		result: "A reproducible interaction, observations and a diagnosis.",
		roles: ALL_ROLES,
		method: [
			"Capture console and network state before and after each critical interaction; take a screenshot only when layout matters. Find the root cause before proposing a fix.",
			"Save runtime evidence (screenshot, DOM dump, console or network excerpt, trace summary) under `.pi/agent-sessions/artifacts/evidence/` and cite the paths. Never mark a runtime-ui assertion proven from a static reading.",
			"A researcher or reviewer only observes; stateful interaction and test artifacts need an editor. Without browser tools on your route, say so instead of guessing.",
		].join("\n"),
	}),
	documentation: record({
		id: "documentation",
		title: "Documentation",
		skills: ["documentation-and-adrs"],
		result: "Accurate user guidance or a recorded decision.",
		roles: ["editor"],
		method: [
			"Prefer updating the project's documentation entry points (`docs:` in `.ai/agent-fleet-overrides.md`) over new files, keep indexes and cross-links current, and check every statement against the code.",
			"A compound task (session lessons into rules or docs) follows the compound-learning skill exactly.",
		].join("\n"),
	}),
	release: record({
		id: "release",
		title: "Release",
		skills: ["shipping-and-launch", "git-workflow-and-versioning"],
		result: "Release preparation and readiness evidence.",
		roles: ["editor"],
		method: [
			"Prepare the release: the changeset with the correct bump, version and changelog, and readiness checks (tests pass, expected tree state). Refuse on a failing or dirty tree and say why.",
			"Publishing — pushing, pushing tags, `npm publish`, creating a hosted release — needs separate explicit permission. This practice alone never authorizes it; report what remains for the person who publishes.",
		].join("\n"),
	}),
});

export function isPracticeId(value: string): value is PracticeId {
	return (PRACTICE_IDS as readonly string[]).includes(value);
}

export function normalizePracticeInput(value: string): string {
	return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Workspace-relative skill roots in native-first order. */
export const SKILL_LOOKUP_ROOTS: readonly (readonly string[])[] = Object.freeze([
	Object.freeze(["skills"]),
	Object.freeze([".pi", "skills"]),
	Object.freeze(["vendor", "agent-skills-upstream", "skills"]),
]);

export interface ResolvedSkill {
	readonly name: string;
	/** Absolute SKILL.md path, or null when no root carries the skill. */
	readonly path: string | null;
}

/** Native-first lookup across the workspace root, then the Fleet resource root. */
export function resolveSkill(name: string, roots: readonly string[]): ResolvedSkill {
	const seen = new Set<string>();
	for (const base of roots) {
		for (const parts of SKILL_LOOKUP_ROOTS) {
			const candidate = resolve(base, ...parts, name, "SKILL.md");
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			if (existsSync(candidate)) return Object.freeze({ name, path: candidate });
		}
	}
	return Object.freeze({ name, path: null });
}

export function practiceSkillPaths(practice: PracticeRecord, roots: readonly string[]): ResolvedSkill[] {
	return practice.skills.map(skill => resolveSkill(skill, roots));
}

export function skillRootLabel(path: string, base: string): string {
	const prefix = resolve(base) + "/";
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export const PRACTICE_CATALOG_HELP = `Practices: ${PRACTICE_IDS.join(", ")}.`;

/** Used by tests and docs to show where the catalog looks. */
export function skillLookupDescription(): string {
	return SKILL_LOOKUP_ROOTS.map(parts => `${join(...parts)}/<name>/SKILL.md`).join(" → ");
}
