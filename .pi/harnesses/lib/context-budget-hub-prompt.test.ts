import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posturePrompt } from "../agent-hub/posture.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger, type HubPromptParts } from "./context-budget-hub-prompt.ts";

function representativeParts(posture: "operator" | "orchestrator", herdr: boolean): HubPromptParts & {
	agentCards: { id: string; text: string }[];
	researchCards: { id: string; text: string }[];
} {
	const pose = posturePrompt(posture);
	const agentCards = [
		{ id: "builder", text: "### Builder\n**Dispatch as:** `builder`\nImplements slices.\n**Tools:** read,write" },
		{ id: "reviewer", text: "### Reviewer\n**Dispatch as:** `reviewer`\nReviews code.\n**Tools:** read" },
	];
	const researchCards = [
		{ id: "deep-researcher", text: "### Deep Researcher\n**Spawn as:** `spawn_research(persona: \"deep-researcher\")`\n**Model:** local · **Thinking:** off\nCross-cutting recon." },
		{ id: "coverage-scout", text: "### Coverage Scout\n**Spawn as:** `spawn_research(persona: \"coverage-scout\")`\n**Model:** local · **Thinking:** off\nTest inventory." },
	];
	return {
		intro: pose.intro,
		toolList: "these tools: `dispatch_agent`, `spawn_research`",
		languageLines: "- ALWAYS communicate with the human user in **English**.",
		activeTeamName: "default",
		teamMembers: "Builder, Reviewer",
		dispatchSection: "- Dispatch tasks via `dispatch_agent`.",
		userLanguage: "English",
		askUserBlock: "## ask_user is NOT available in this session",
		modeSection: "## Task triage (before dispatch)",
		verificationSection: "## Verification Contract",
		comsSection: "",
		herdrSection: herdr ? HUB_HERDR_SECTION : "",
		hardRules: pose.hardRules,
		ambiguityRule: "- NEVER proceed past an ambiguity by guessing.",
		agentCatalog: agentCards.map((card) => card.text).join("\n\n"),
		researchCatalog: researchCards.map((card) => card.text).join("\n\n"),
		dispatcherPersonaPrompt: undefined,
		agentCards,
		researchCards,
	};
}

test("compact stable policy preserves posture, backend, ambiguity, and evidence invariants", () => {
	const operator = assembleHubSystemPrompt(representativeParts("operator", false));
	const orchestrator = assembleHubSystemPrompt(representativeParts("orchestrator", false));
	assert.notEqual(operator, orchestrator);
	assert.match(operator, /Fleet operator/);
	assert.match(orchestrator, /dispatcher agent — an orchestrator/);
	for (const prompt of [operator, orchestrator]) {
		assert.match(prompt, /backend: native.*backend: coms.*backend: auto/s);
		assert.match(prompt, /NEVER proceed past an ambiguity by guessing/);
		assert.match(prompt, /returned evidence before reporting completion/);
		assert.match(prompt, /Task triage/);
	}
});

test("ledger identifies each roster and research card and does not mutate the prompt", () => {
	const parts = representativeParts("operator", true);
	const prompt = assembleHubSystemPrompt(parts);
	const ledger = recordHubLedger(prompt, namedHubLedgerParts(parts));
	assert.equal(assembleHubSystemPrompt(parts), prompt);
	assert.ok(ledger.some((entry) => entry.id === "hub/roster/builder"));
	assert.ok(ledger.some((entry) => entry.id === "hub/roster/reviewer"));
	assert.ok(ledger.some((entry) => entry.id === "hub/research/deep-researcher"));
	assert.ok(ledger.some((entry) => entry.id === "hub/research/coverage-scout"));
	const herdr = ledger.find((entry) => entry.id === "hub/policy/workspace");
	assert.equal(herdr?.chars, HUB_HERDR_SECTION.length);
	assert.equal(herdr?.confidence, "exact-chars");
	assert.equal(ledger.find(entry => entry.id === "hub/policy/dispatch")?.persistence, "fixed");
	assert.equal(ledger.find(entry => entry.id === "hub/state")?.persistence, "turn");
	assert.equal(ledger.reduce((sum, entry) => sum + entry.chars, 0), prompt.length);
});

test("volatile state is separately attributable while stable policy stays byte-stable", () => {
	const first = { ...representativeParts("orchestrator", false), stateCapsule: "## Current task state\n- dispatches: 1" };
	const second = { ...first, stateCapsule: "## Current task state\n- dispatches: 10" };
	const firstLedger = recordHubLedger(assembleHubSystemPrompt(first), namedHubLedgerParts(first));
	const secondLedger = recordHubLedger(assembleHubSystemPrompt(second), namedHubLedgerParts(second));
	const stable = (ledger: ReturnType<typeof recordHubLedger>) => ledger.filter(entry => entry.id !== "hub/state").map(entry => [entry.id, entry.chars, entry.source]);
	assert.deepEqual(stable(firstLedger), stable(secondLedger));
	assert.notEqual(firstLedger.find(entry => entry.id === "hub/state")?.chars, secondLedger.find(entry => entry.id === "hub/state")?.chars);
});

test("policy duplication guard keeps detailed protocols out of the Hub persona", () => {
	const persona = readFileSync(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");
	assert.match(persona, /skills\/orchestration-verification\/SKILL\.md/);
	for (const duplicatedParagraph of ["Cap the open ledger at 8", "Give a peer time, not retries", "ASK_USER:", "NEEDS_RESEARCH:"]) assert.doesNotMatch(persona, new RegExp(duplicatedParagraph));
});

test("inactive pack policy fragments are absent and active fragments are attributed deterministically", () => {
	const inactive = { ...representativeParts("operator", false), dispatchSection: "", verificationSection: "", comsSection: "", herdrSection: "", compactionSection: "", agentCatalog: "", researchCatalog: "", agentCards: [], researchCards: [] };
	const inactivePrompt = assembleHubSystemPrompt(inactive);
	const inactiveLedger = recordHubLedger(inactivePrompt, namedHubLedgerParts(inactive));
	for (const id of ["hub/policy/dispatch", "hub/policy/verification", "hub/policy/coms", "hub/policy/workspace", "hub/policy/compaction"]) {
		assert.equal(inactiveLedger.find(entry => entry.id === id)?.chars, 0, `${id} must cost zero`);
	}
	assert.doesNotMatch(inactivePrompt, /Native Roster|Verification Contract|Peer agents|Fleet \(herdr\)|Context recovery/);

	const active = { ...representativeParts("orchestrator", true), compactionSection: "## Context recovery\n- request_compaction is active." };
	const activeLedger = recordHubLedger(assembleHubSystemPrompt(active), namedHubLedgerParts(active));
	assert.ok((activeLedger.find(entry => entry.id === "hub/policy/compaction")?.chars ?? 0) > 0);
	assert.equal(activeLedger.reduce((sum, entry) => sum + entry.chars, 0), assembleHubSystemPrompt(active).length);
});

test("herdr is actual, zero, or unavailable — never an enabled placeholder", () => {
	const off = representativeParts("orchestrator", false);
	const offLedger = recordHubLedger(assembleHubSystemPrompt(off), namedHubLedgerParts(off));
	const herdr = offLedger.find((entry) => entry.id === "hub/policy/workspace");
	assert.equal(herdr?.chars, 0);
	assert.equal(herdr?.confidence, "exact-chars");
	assert.doesNotMatch(JSON.stringify(herdr), /enabled/);
	assert.equal(assembleHubSystemPrompt(off).includes("## Fleet (herdr)"), false);
	assert.equal(assembleHubSystemPrompt(representativeParts("orchestrator", true)).includes("## Fleet (herdr)"), true);
});
