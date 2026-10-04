import { DELEGATE_TREE_SPAWN_BUDGET } from "../agent-hub/helpers.ts";
import { externalBlockedProtocol } from "../agent-hub/external-blocker.js";

export { DELEGATE_TREE_SPAWN_BUDGET };
export const RESEARCH_TOOLS = "read,grep,find,ls";
export const MAX_AUTO_RESEARCH_QUESTIONS = 4;
/** Deterministic reference estimate: four serialized characters per token. */
export const RESEARCH_STANDING_TOKEN_CEILING = 3_000;
export const RESEARCH_TOKEN_CHARS = 4;

export function buildClarificationProtocol(userLanguage: string, maxQuestions = MAX_AUTO_RESEARCH_QUESTIONS): string {
	return `

## Clarification protocol
If at any point you need a decision from the human user (ambiguity, missing input,
contradiction, or a destructive/irreversible next step), DO NOT guess. Stop and
return a single line of the form:

  ASK_USER: <your question in one clear English sentence>

You may emit multiple ASK_USER lines if you have several questions. The dispatcher
will surface each to the human user in ${userLanguage} and re-dispatch you with the
answers. Do not invent values, do not pick "reasonable defaults" silently — ask.

## External-blocker protocol
${externalBlockedProtocol()}

## Research protocol
If you need reconnaissance you cannot perform with your own tools (broad code search,
reading unfamiliar areas of the codebase, summarizing docs), DO NOT guess and DO NOT
ask the user. Pause for research instead: end your turn with one or more lines of the
form

  NEEDS_RESEARCH: <one specific, self-contained question>

with nothing after them. Your session pauses there; read-only research helpers are
spawned for you, each helper's findings are saved to a file, and you are resumed in
this same session with the file paths — read them and continue from where you left
off. Ask at most ${maxQuestions} questions per pause. Use ASK_USER only
for decisions a human must make; use NEEDS_RESEARCH for facts that can be looked up.`;
}

export function buildDelegationProtocol(roleNames: readonly string[], spawnBudget = DELEGATE_TREE_SPAWN_BUDGET): string {
	if (roleNames.length === 0) return "";
	return `

## Delegation protocol
You have a \`delegate\` tool with pre-configured sub-agents on cheaper models
(roles: ${roleNames.join(", ")}). Prefer delegating scoped, self-contained
sub-tasks to them over doing everything yourself. A child shares NONE of your
context — put everything it needs into its instruction/context. You may run up
to ${spawnBudget} delegate calls for this dispatch; parallel children are forced read-only.
Children are terminal workers: they do not receive delegate tooling at remaining depth 0.`;
}

export function buildDeliverableProtocol(agentKey: string, runNumber: number, artifactRoot = ".pi/agent-sessions/artifacts", dispatchId?: string): string {
	const filename = `${agentKey}-${dispatchId ?? `run${runNumber}`}.md`;
	return `

## Deliverable-to-file protocol
When your deliverable is a document (plan, review, critique, inventory, report), write the full document to the real session artifact path when your tools allow it: ${artifactRoot}/<kind>/${filename} (kinds: plans, reviews, inventories, evidence). Do NOT write repo-root ./artifacts/... files. In your final response, report and pass the artifact-relative handoff path: artifacts/<kind>/${filename}. If your persona already has an explicit output path contract such as planner PLAN_FILE, keep that existing behavior and also summarize/return the session artifact path the hub gives you.
Finish with the artifact-relative path plus a digest of no more than 10 lines. If the dispatch includes acceptance assertions (A1, A2, ...), also include the structured return from skills/orchestration-verification/SKILL.md. If your tools are read-only and you cannot write a document artifact yourself, finish with the digest + structured return; the hub will still persist your full final return under artifacts/returns/ for dispatcher recovery.`;
}

export interface ChildPromptParts {
	id: string;
	category: "persona" | "tool" | "system" | "protocol";
	label: string;
	chars: number;
}

export interface SpecialistContextManifest {
	persona: { name: string; sourcePath: string; primarySkillPaths: string[] };
	taskSkillPaths: string[];
	projectPolicy: { rulesPaths: string[]; docsPaths: string[] };
	flags: { assertions: boolean; scope: boolean; artifacts: boolean };
	delegateRoles: string[];
	protocolIds: string[];
}

export function buildProjectRulesProtocol(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	return `

## Project rules
This project keeps its own rules in: ${paths.join(", ")} (repo-relative).
Rules are HOW constraints — read the ones relevant to your task and comply with them.
Read a listed file directly. Resolve them index-first when they are folders: if one has a
top-level README.md or index.md, read that first and follow its loading manifest
(session bundles, "load X when Y" lists) to select only the rule files that apply;
do not bulk-read the tree. Only when a folder has no such index, discover rule files
recursively (\`find <dir> -type f\`) and read the relevant ones. If you plan or review
work, validate your subject against the rules; when delegating, pass the relevant
rule file paths and specific points to check to the child.`;
}

export function buildProjectDocsProtocol(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	return `

## Project docs
This project's canonical documentation entry points are: ${paths.join(", ")}
(repo-relative). Docs carry WHAT/WHY context — architecture, standards, decisions.
They orient you; they are not compliance rules. Read a listed file directly. For a
listed folder, start from its README.md or index.md and follow only links relevant
to the task rather than bulk-reading doc trees. If your work changes something the
docs describe (architecture, public APIs, commands, structure), say so in your final
response so the docs can be updated.`;
}

export function buildSelectedProjectPolicyProtocol(manifest: SpecialistContextManifest): string {
	const selected = new Set(manifest.protocolIds);
	return (selected.has("rules") ? buildProjectRulesProtocol(manifest.projectPolicy.rulesPaths) : "") +
		(selected.has("docs") ? buildProjectDocsProtocol(manifest.projectPolicy.docsPaths) : "");
}

const skillPaths = (text: string) => [...new Set(text.match(/(?:^|[\s`(])((?:\.?\/?skills\/)[\w./-]+\/SKILL\.md)/g) ?? [])]
	.map(match => match.match(/((?:\.?\/?skills\/)[\w./-]+\/SKILL\.md)/)?.[1] ?? "")
	.filter(Boolean);

export function buildSpecialistContextManifest(input: {
	personaName: string;
	personaPath: string;
	personaPrompt: string;
	task: string;
	rulesPaths: readonly string[];
	docsPaths: readonly string[];
	hasAssertions: boolean;
	hasScope: boolean;
	hasArtifacts: boolean;
	delegateRoles: readonly string[];
}): SpecialistContextManifest {
	const protocolIds = ["clarification", "external-blocker", "research", "deliverable"];
	if (input.rulesPaths.length) protocolIds.push("rules");
	if (input.docsPaths.length) protocolIds.push("docs");
	if (input.hasAssertions) protocolIds.push("verification");
	if (input.delegateRoles.length) protocolIds.push("delegation");
	return {
		persona: { name: input.personaName, sourcePath: input.personaPath, primarySkillPaths: skillPaths(input.personaPrompt) },
		taskSkillPaths: skillPaths(input.task),
		projectPolicy: { rulesPaths: [...input.rulesPaths], docsPaths: [...input.docsPaths] },
		flags: { assertions: input.hasAssertions, scope: input.hasScope, artifacts: input.hasArtifacts },
		delegateRoles: [...input.delegateRoles],
		protocolIds,
	};
}

export function nativeSpecialistSystemPrompt(input: { manifest: SpecialistContextManifest; userLanguage: string; agentKey: string; runNumber: number; artifactRoot?: string; dispatchId?: string }): string {
	const { manifest } = input;
	const paths = (label: string, values: string[]) => values.length ? `\n${label}: ${values.join(", ")}` : "";
	const framing = [
		"Task is supplied via stdin.",
		...(manifest.flags.scope ? ["Declared scope is supplied via stdin."] : []),
		...(manifest.flags.artifacts ? ["Artifact paths are supplied via stdin."] : []),
	];
	const references = `# Managed Specialist\nPersona: ${manifest.persona.name}; source: ${manifest.persona.sourcePath}.${paths("Primary skills", manifest.persona.primarySkillPaths)}${paths("Task-selected skills", manifest.taskSkillPaths)}${paths("Applicable project rules", manifest.projectPolicy.rulesPaths)}${paths("Applicable project docs", manifest.projectPolicy.docsPaths)}\n${framing.join(" ")} Read the persona source before work and applicable project rules before edits or commands. Read only the named skill and documentation paths when relevant; do not discover global skills or context files.`;
	let prompt = references + buildSelectedProjectPolicyProtocol(manifest) + buildClarificationProtocol(input.userLanguage);
	if (manifest.flags.assertions) prompt += "\n\n## Verification\nRead skills/orchestration-verification/SKILL.md for the structured return contract; apply the assertions supplied in the task.";
	if (manifest.delegateRoles.length) prompt += buildDelegationProtocol(manifest.delegateRoles);
	prompt += buildDeliverableProtocol(input.agentKey, input.runNumber, input.artifactRoot, input.dispatchId);
	return prompt;
}

export function specialistStandingParts(input: {
	replacementPrompt: string;
	toolChars: number;
}): ChildPromptParts[] {
	return [
		{ id: "specialist-replacement", category: "system", label: "Replacement specialist manifest prompt", chars: input.replacementPrompt.length },
		{ id: "child-tools", category: "tool", label: "Configured child tools", chars: input.toolChars },
		{ id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: 0 },
	];
}

export function researchStandingParts(input: {
	replacementPrompt: string;
	toolChars: number;
	basePromptChars: number;
}): ChildPromptParts[] {
	const parts = [
		{ id: "research-replacement", category: "system" as const, label: "Replacement read-only research prompt", chars: input.replacementPrompt.length },
		{ id: "child-tools", category: "tool" as const, label: "Configured child tools", chars: input.toolChars },
		{ id: "pi-base", category: "system" as const, label: "Pi child base prompt inputs", chars: input.basePromptChars },
	];
	const standingChars = parts.reduce((sum, part) => sum + part.chars, 0);
	if (Math.ceil(standingChars / RESEARCH_TOKEN_CHARS) > RESEARCH_STANDING_TOKEN_CEILING) {
		throw new Error(`Research standing overhead exceeds ${RESEARCH_STANDING_TOKEN_CEILING} estimated tokens`);
	}
	return parts;
}

export function delegateStandingParts(input: {
	toolChars: number;
	basePromptChars: number;
	roleNames: readonly string[];
}): ChildPromptParts[] {
	return [
		{ id: "delegate-protocol", category: "protocol", label: "Resolved delegate role protocol", chars: buildDelegationProtocol(input.roleNames).length },
		{ id: "child-tools", category: "tool", label: "Resolved delegate tools", chars: input.toolChars },
		{ id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: input.basePromptChars },
	];
}

export function nativeResearchSystemPrompt(input: {
	personaName?: string;
	personaPath?: string;
	cwd: string;
	rulesPaths?: readonly string[];
	docsPaths?: readonly string[];
}): string {
	const persona = input.personaName && input.personaPath
		? `\nSelected persona: ${input.personaName}. Its source is ${input.personaPath}; read that one file only when its role guidance is needed.`
		: "\nNo persona is selected; act as a general research helper.";
	const policy = buildProjectRulesProtocol(input.rulesPaths ?? []) + buildProjectDocsProtocol(input.docsPaths ?? []);
	return `# Read-only Research Helper
You investigate the requested repository topic for a parent agent. Your only tools are read, grep, find, and ls. Do not edit, write, run bash, delegate, or claim those tools are available.${persona}
Working directory: ${input.cwd}${policy}
Task input may name artifact paths; inspect only paths relevant to that task. Report concise findings with concrete path:line citations. State uncertainty or missing evidence plainly. Return findings only; do not propose or attempt edits.`;
}
