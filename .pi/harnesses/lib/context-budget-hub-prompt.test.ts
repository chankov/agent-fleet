import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posturePrompt } from "../agent-hub/posture.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger, type HubPromptParts } from "./context-budget-hub-prompt.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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
		modeSection: "## Execution mode: standard",
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

test("operator and orchestrator prompts match committed pre-ledger characterizations byte-for-byte", () => {
	const operator = assembleHubSystemPrompt(representativeParts("operator", false));
	const orchestrator = assembleHubSystemPrompt(representativeParts("orchestrator", false));
	assert.equal(operator, fixture("hub-prompt-operator.legacy.txt"));
	assert.equal(orchestrator, fixture("hub-prompt-orchestrator.legacy.txt"));
	assert.notEqual(operator, orchestrator);
	assert.match(operator, /Fleet operator/);
	assert.match(orchestrator, /dispatcher agent — an orchestrator/);
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
	const herdr = ledger.find((entry) => entry.id === "hub/herdr");
	assert.equal(herdr?.chars, HUB_HERDR_SECTION.length);
	assert.equal(herdr?.confidence, "exact-chars");
	assert.equal(ledger.reduce((sum, entry) => sum + entry.chars, 0), prompt.length);
});

test("herdr is actual, zero, or unavailable — never an enabled placeholder", () => {
	const off = representativeParts("orchestrator", false);
	const offLedger = recordHubLedger(assembleHubSystemPrompt(off), namedHubLedgerParts(off));
	const herdr = offLedger.find((entry) => entry.id === "hub/herdr");
	assert.equal(herdr?.chars, 0);
	assert.equal(herdr?.confidence, "unavailable");
	assert.doesNotMatch(JSON.stringify(herdr), /enabled/);
	assert.equal(assembleHubSystemPrompt(off).includes("## Fleet (herdr)"), false);
	assert.equal(assembleHubSystemPrompt(representativeParts("orchestrator", true)).includes("## Fleet (herdr)"), true);
});
