import test from "node:test";
import assert from "node:assert/strict";
import {
	buildClarificationProtocol,
	buildDelegationProtocol,
	buildDeliverableProtocol,
	delegateStandingParts,
	nativeResearchAppendedPrompt,
	nativeSpecialistAppendedPrompt,
	RESEARCH_PROTOCOL,
	researchStandingParts,
	specialistStandingParts,
} from "./context-budget-child-prompt.ts";

test("specialist cold-start parts match native spawn append composition", () => {
	const systemPrompt = "# Builder\nDo the work.";
	const rules = "\n## Project rules\nrules/";
	const docs = "\n## Project docs\ndocs/";
	const native = nativeSpecialistAppendedPrompt({
		systemPrompt,
		userLanguage: "English",
		rulesProtocol: rules,
		docsProtocol: docs,
		delegateRoles: ["coverage-scout"],
		agentKey: "builder",
		runNumber: 0,
	});
	const parts = specialistStandingParts({
		personaChars: systemPrompt.length,
		toolChars: 12,
		basePromptChars: 8,
		docsProtocol: docs,
		rulesProtocol: rules,
		userLanguage: "English",
		delegateRoles: ["coverage-scout"],
		agentKey: "builder",
		runNumber: 0,
	});
	const standing = parts.filter(p => p.id !== "child-tools" && p.id !== "pi-base").reduce((sum, p) => sum + p.chars, 0);
	assert.equal(standing, native.length);
	assert.deepEqual(parts.map(p => p.id), [
		"persona", "child-tools", "pi-base", "docs-protocol",
		"clarification-protocol", "rules-protocol", "delegation-protocol", "deliverable-protocol",
	]);
	assert.equal(parts.find(p => p.id === "clarification-protocol")?.chars, buildClarificationProtocol("English").length);
	assert.equal(parts.find(p => p.id === "deliverable-protocol")?.chars, buildDeliverableProtocol("builder", 0).length);
	assert.equal(parts.find(p => p.id === "delegation-protocol")?.chars, buildDelegationProtocol(["coverage-scout"]).length);
});

test("research cold-start parts match native research append composition", () => {
	const persona = "# Scout";
	const docs = "\n## Project docs\n";
	const native = nativeResearchAppendedPrompt(persona, docs);
	const parts = researchStandingParts({ personaChars: persona.length, toolChars: 4, basePromptChars: 2, docsProtocol: docs });
	assert.equal(parts.find(p => p.id === "research-protocol")?.chars, RESEARCH_PROTOCOL.length);
	assert.equal(parts.filter(p => !["child-tools", "pi-base"].includes(p.id)).reduce((s, p) => s + p.chars, 0), native.length);
});

test("known delegates project protocol plus tools; empty roles stay empty", () => {
	const known = delegateStandingParts({ toolChars: 20, basePromptChars: 5, roleNames: ["scout"] });
	assert.ok(known.every(p => p.chars > 0 || p.id === "pi-base"));
	assert.equal(buildDelegationProtocol([]).length, 0);
});
