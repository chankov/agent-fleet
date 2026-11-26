import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProjectPolicyFixture, FIXTURE_POLICY_MARKER } from "../../../bin/test/helpers/project-policy-fixture.js";
import {
	buildClarificationProtocol,
	buildSpecialistContextManifest,
	buildDelegationProtocol,
	delegateStandingParts,
	nativeResearchSystemPrompt,
	nativeSpecialistSystemPrompt,
	RESEARCH_STANDING_TOKEN_CEILING,
	RESEARCH_TOKEN_CHARS,
	researchStandingParts,
	specialistStandingParts,
} from "./context-budget-child-prompt.ts";

test("specialist manifest composes only selected references and protocols", () => {
	const manifest = buildSpecialistContextManifest({
		personaName: "Editor", personaPath: "agents/editor.md",
		personaPrompt: "Read skills/incremental-implementation/SKILL.md first.",
		task: "Use skills/test-driven-development/SKILL.md and input artifact.",
		rulesPaths: ["AGENTS.md", "rules"], docsPaths: ["docs/ARCHITECTURE.md"],
		hasAssertions: true, hasScope: true, hasArtifacts: true, delegateRoles: ["coverage-scout"],
	});
	const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "editor", runNumber: 2 });
	const parts = specialistStandingParts({ replacementPrompt: prompt, toolChars: 12 });
	assert.deepEqual(manifest.persona.primarySkillPaths, ["skills/incremental-implementation/SKILL.md"]);
	assert.deepEqual(manifest.taskSkillPaths, ["skills/test-driven-development/SKILL.md"]);
	assert.deepEqual(manifest.protocolIds, ["clarification", "external-blocker", "research", "deliverable", "rules", "docs", "verification", "delegation"]);
	assert.match(prompt, /agents\/editor\.md/);
	assert.match(prompt, /skills\/incremental-implementation\/SKILL\.md/);
	assert.match(prompt, /skills\/test-driven-development\/SKILL\.md/);
	assert.match(prompt, /Applicable project rules: AGENTS\.md, rules/);
	assert.match(prompt, /Read the persona source before work and applicable project rules before edits or commands/);
	assert.match(prompt, /Declared scope is supplied via stdin/);
	assert.match(prompt, /Artifact paths are supplied via stdin/);
	assert.doesNotMatch(prompt, /Use skills\/test-driven-development\/SKILL\.md and input artifact/);
	assert.match(prompt, /orchestration-verification\/SKILL\.md/);
	assert.match(prompt, /roles: coverage-scout/);
	assert.equal(parts.find(p => p.id === "specialist-replacement")?.chars, prompt.length);
	assert.equal(parts.find(p => p.id === "pi-base")?.chars, 0);
});

test("managed specialist fixtures retain each role's primary skill and conditional policy manifest", () => {
	// The shipped role definitions (PLAN-11-01). Practice skills reach the worker
	// through the assignment block in the task; the role prompt itself cites only
	// the structured-return contract.
	const fixtures = [
		{ name: "Editor", file: "editor.md", skills: ["skills/orchestration-verification/SKILL.md"] },
		{ name: "Reviewer", file: "reviewer.md", skills: ["skills/orchestration-verification/SKILL.md"] },
		{ name: "Researcher", file: "researcher.md", skills: [] as string[] },
	];
	for (const fixture of fixtures) {
		const personaPath = `agents/${fixture.file}`;
		const personaPrompt = readFileSync(new URL(`../../../${personaPath}`, import.meta.url), "utf8");
		const manifest = buildSpecialistContextManifest({
			personaName: fixture.name, personaPath, personaPrompt, task: "Complete the scoped task.",
			rulesPaths: ["AGENTS.md"], docsPaths: ["docs/ARCHITECTURE.md"],
			hasAssertions: true, hasScope: true, hasArtifacts: true, delegateRoles: [],
		});
		const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: fixture.file.replace(/\.md$/, ""), runNumber: 1 });
		assert.deepEqual(manifest.persona.primarySkillPaths, fixture.skills, `${fixture.name} primary skills`);
		assert.deepEqual(manifest.protocolIds, ["clarification", "external-blocker", "research", "deliverable", "rules", "docs", "verification"]);
		for (const skill of fixture.skills) assert.match(prompt, new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(prompt, new RegExp(`source: agents/${fixture.file.replace(".", "\\.")}`));
		assert.match(prompt, /Applicable project rules: AGENTS\.md/);
		assert.match(prompt, /Applicable project docs: docs\/ARCHITECTURE\.md/);
	}
});

test("specialist resume reuses manifest while only the run artifact destination changes", () => {
	const manifest = buildSpecialistContextManifest({
		personaName: "Editor", personaPath: "agents/editor.md", personaPrompt: "", task: "initial task",
		rulesPaths: [], docsPaths: [], hasAssertions: true, hasScope: true, hasArtifacts: true, delegateRoles: [],
	});
	const first = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "editor", runNumber: 1 });
	const resumed = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "editor", runNumber: 2 });
	assert.equal(first.replace(/editor-run1/g, "editor-runN"), resumed.replace(/editor-run2/g, "editor-runN"));
	assert.match(resumed, /editor-run2/);
});

test("rendered child consumes rules protocolIds with index-first policy guidance", () => {
	const project = createProjectPolicyFixture("child-policy-");
	try {
		const rule = readFileSync(`${project.cwd}/${project.applicableRule}`, "utf8");
		assert.equal(project.task.includes(FIXTURE_POLICY_MARKER), false, "fixture policy is absent from the user task");
		assert.match(rule, /planning\nacceptance criteria, edit verification notes, and review findings/);
		const manifest = buildSpecialistContextManifest({
			personaName: "Editor", personaPath: "agents/editor.md", personaPrompt: "", task: project.task,
			rulesPaths: project.rulesPaths, docsPaths: [], hasAssertions: false, hasScope: false, hasArtifacts: false, delegateRoles: [],
		});
		assert.ok(manifest.protocolIds.includes("rules"), "fixture reaches the production manifest");
		const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "editor", runNumber: 1 });
		assert.match(prompt, /Resolve them index-first/);
		assert.match(prompt, /README\.md or index\.md/);
		assert.doesNotMatch(prompt, /reference-only|UNRELATED_ARCHIVE_SENTINEL/);
	} finally { project.cleanup(); }
});

test("specialist omission paths do not emit verification, policy, or delegation prose", () => {
	const manifest = buildSpecialistContextManifest({
		personaName: "Editor", personaPath: "agents/editor.md", personaPrompt: "", task: "plain task",
		rulesPaths: [], docsPaths: [], hasAssertions: false, hasScope: false, hasArtifacts: false, delegateRoles: [],
	});
	const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "editor", runNumber: 0 });
	assert.deepEqual(manifest.protocolIds, ["clarification", "external-blocker", "research", "deliverable"]);
	assert.doesNotMatch(prompt, /Applicable project rules|Applicable project docs|## Verification|## Delegation/);
});

test("research cold-start parts match the replacement research spawn composition and ceiling", () => {
	const replacementPrompt = nativeResearchSystemPrompt({
		personaName: "Scout",
		personaPath: "agents/scout.md",
		cwd: "/repo",
	});
	const parts = researchStandingParts({ replacementPrompt, toolChars: 4, basePromptChars: 0 });
	assert.equal(parts.find(p => p.id === "research-replacement")?.chars, replacementPrompt.length);
	assert.equal(parts.find(p => p.id === "pi-base")?.chars, 0, "replacement policy has no inherited Pi prompt inputs");
	const standingChars = parts.reduce((sum, part) => sum + part.chars, 0);
	assert.ok(Math.ceil(standingChars / RESEARCH_TOKEN_CHARS) <= RESEARCH_STANDING_TOKEN_CEILING);
	assert.match(replacementPrompt, /Selected persona: Scout/);
	assert.match(replacementPrompt, /agents\/scout\.md/);
	assert.match(replacementPrompt, /Working directory: \/repo/);
	assert.match(replacementPrompt, /path:line citations/);
	assert.match(replacementPrompt, /Do not edit, write, run bash, delegate/);
});

test("known delegates project protocol plus tools; empty roles stay empty", () => {
	const known = delegateStandingParts({ toolChars: 20, basePromptChars: 5, roleNames: ["scout"] });
	assert.ok(known.every(p => p.chars > 0 || p.id === "pi-base"));
	assert.equal(buildDelegationProtocol([]).length, 0);
});


test("specialist clarification uses parent-first routing without inventing human consent", () => {
 const prompt = buildClarificationProtocol("Bulgarian");
 assert.match(prompt, /Resolve routine technical choices independently/);
 assert.match(prompt, /marker goes to the orchestrator first/);
 assert.match(prompt, /ORCHESTRATOR_ANSWER is a model clarification, not human consent/);
 assert.match(prompt, /Human escalations are presented in Bulgarian/);
 assert.match(prompt, /NEEDS_RESEARCH:/);
 assert.doesNotMatch(prompt, /will surface each to the human/);
});
