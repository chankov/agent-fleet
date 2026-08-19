import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
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
		personaName: "Builder", personaPath: "agents/builder.md",
		personaPrompt: "Read skills/incremental-implementation/SKILL.md first.",
		task: "Use skills/test-driven-development/SKILL.md and input artifact.",
		rulesPaths: ["AGENTS.md", "rules"], docsPaths: ["docs/ARCHITECTURE.md"],
		hasAssertions: true, hasScope: true, hasArtifacts: true, delegateRoles: ["coverage-scout"],
	});
	const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "builder", runNumber: 2 });
	const parts = specialistStandingParts({ replacementPrompt: prompt, toolChars: 12 });
	assert.deepEqual(manifest.persona.primarySkillPaths, ["skills/incremental-implementation/SKILL.md"]);
	assert.deepEqual(manifest.taskSkillPaths, ["skills/test-driven-development/SKILL.md"]);
	assert.deepEqual(manifest.protocolIds, ["clarification", "external-blocker", "research", "deliverable", "rules", "docs", "verification", "delegation"]);
	assert.match(prompt, /agents\/builder\.md/);
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
	const fixtures = [
		{ name: "Builder", file: "builder.md", skill: "skills/incremental-implementation/SKILL.md" },
		{ name: "Code Reviewer", file: "code-reviewer.md", skill: "skills/code-review-and-quality/SKILL.md" },
		{ name: "Test Engineer", file: "test-engineer.md", skill: "skills/test-driven-development/SKILL.md" },
		{ name: "Web Debugger", file: "web-debugger.md", skill: "skills/browser-testing-with-devtools/SKILL.md" },
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
		assert.ok(manifest.persona.primarySkillPaths.includes(fixture.skill), `${fixture.name} primary skill`);
		assert.deepEqual(manifest.protocolIds, ["clarification", "external-blocker", "research", "deliverable", "rules", "docs", "verification"]);
		assert.match(prompt, new RegExp(fixture.skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(prompt, /Applicable project rules: AGENTS\.md/);
		assert.match(prompt, /Applicable project docs: docs\/ARCHITECTURE\.md/);
	}
});

test("specialist resume reuses manifest while only the run artifact destination changes", () => {
	const manifest = buildSpecialistContextManifest({
		personaName: "Builder", personaPath: "agents/builder.md", personaPrompt: "", task: "initial task",
		rulesPaths: [], docsPaths: [], hasAssertions: true, hasScope: true, hasArtifacts: true, delegateRoles: [],
	});
	const first = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "builder", runNumber: 1 });
	const resumed = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "builder", runNumber: 2 });
	assert.equal(first.replace(/builder-run1/g, "builder-runN"), resumed.replace(/builder-run2/g, "builder-runN"));
	assert.match(resumed, /builder-run2/);
});

test("specialist omission paths do not emit verification, policy, or delegation prose", () => {
	const manifest = buildSpecialistContextManifest({
		personaName: "Builder", personaPath: "agents/builder.md", personaPrompt: "", task: "plain task",
		rulesPaths: [], docsPaths: [], hasAssertions: false, hasScope: false, hasArtifacts: false, delegateRoles: [],
	});
	const prompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey: "builder", runNumber: 0 });
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
