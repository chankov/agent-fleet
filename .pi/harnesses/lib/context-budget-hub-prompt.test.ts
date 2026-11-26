import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workModePrompt } from "../agent-hub/work-mode.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger, type HubPromptParts } from "./context-budget-hub-prompt.ts";

function representativeParts(herdr: boolean): HubPromptParts & {
	roleCards: { id: string; text: string }[];
} {
	const pose = workModePrompt();
	const roleCards = [
		{ id: "researcher", text: "- `researcher` — Read-only investigation. Authority: `spawn_research` only." },
		{ id: "reviewer", text: "- `reviewer` — Independent assessment. Authority: `dispatch_agent`, read-only." },
		{ id: "editor", text: "- `editor` — Changes within scope. Authority: `dispatch_agent`, writes in scope." },
	];
	return {
		intro: pose.intro,
		toolList: "these tools: `dispatch_agent`, `spawn_research`",
		languageLines: "- ALWAYS communicate with the human user in **English**.",
		dispatchSection: "- Dispatch tasks via `dispatch_agent`.",
		askUserBlock: "## ask_user is NOT available in this session",
		modeSection: "## Task triage (before dispatch)",
		verificationSection: "## Verification Contract",
		comsSection: "",
		herdrSection: herdr ? HUB_HERDR_SECTION : "",
		hardRules: pose.hardRules,
		ambiguityRule: "- NEVER proceed past an ambiguity by guessing.",
		roleCatalog: roleCards.map((card) => card.text).join("\n"),
		practiceCatalog: "- `research` — An answer with sources.\n- `implementation` (editor) — A scoped change.",
		roleCards,
	};
}

test("compact stable policy preserves the operator, backend, ambiguity, and evidence invariants", () => {
	const prompt = assembleHubSystemPrompt(representativeParts(false));
	assert.match(prompt, /Fleet operator/);
	assert.doesNotMatch(prompt, /dispatcher agent — an orchestrator/);
	assert.match(prompt, /backend: native.*backend: coms.*backend: auto/s);
	assert.match(prompt, /NEVER proceed past an ambiguity by guessing/);
	assert.match(prompt, /check its returned evidence and follow up on gaps before reporting completion/);
	assert.match(prompt, /Task triage/);
});

test("ledger identifies each role card and the practice catalog and does not mutate the prompt", () => {
	const parts = representativeParts(true);
	const prompt = assembleHubSystemPrompt(parts);
	const ledger = recordHubLedger(prompt, namedHubLedgerParts(parts));
	assert.equal(assembleHubSystemPrompt(parts), prompt);
	for (const role of ["researcher", "reviewer", "editor"]) assert.ok(ledger.some((entry) => entry.id === `hub/role/${role}`), role);
	assert.equal(ledger.find((entry) => entry.id === "hub/practices")?.chars, parts.practiceCatalog.length);
	assert.match(prompt, /## Roles and practices\n[\s\S]*`editor`[\s\S]*\nPractices:\n[\s\S]*`implementation`/);
	assert.doesNotMatch(prompt, /Native Roster|team_adjust|active team|## Agents|Research personas/, "teams are gone (D7)");
	const herdr = ledger.find((entry) => entry.id === "hub/policy/workspace");
	assert.equal(herdr?.chars, HUB_HERDR_SECTION.length);
	assert.equal(herdr?.confidence, "exact-chars");
	assert.equal(ledger.find(entry => entry.id === "hub/policy/dispatch")?.persistence, "fixed");
	assert.equal(ledger.find(entry => entry.id === "hub/state")?.persistence, "turn");
	assert.equal(ledger.reduce((sum, entry) => sum + entry.chars, 0), prompt.length);
});

test("volatile state is separately attributable while stable policy stays byte-stable", () => {
	const parts = representativeParts(false);
	const first = { ...parts, stateCapsule: "## Current task state\n- dispatches: 1" };
	const second = { ...first, stateCapsule: "## Current task state\n- dispatches: 10" };
	const fixedPrompt = assembleHubSystemPrompt(parts);
	const fixedLedger = recordHubLedger(fixedPrompt, namedHubLedgerParts(parts)).slice(0, -1);
	for (const input of [first, second]) {
		const prompt = assembleHubSystemPrompt(input);
		const state = `\n\n${input.stateCapsule}`;
		assert.equal(prompt, fixedPrompt + state);
		const ledger = recordHubLedger(prompt, namedHubLedgerParts(input));
		assert.deepEqual(ledger.slice(0, -1), fixedLedger);
		assert.equal(ledger.at(-1)?.id, "hub/state");
		assert.equal(ledger.at(-1)?.chars, state.length);
		assert.equal(ledger.reduce((sum, entry) => sum + entry.chars, 0), prompt.length);
	}
});


test("inactive pack policy fragments are absent and active fragments are attributed deterministically", () => {
	const inactive = { ...representativeParts(false), dispatchSection: "", verificationSection: "", comsSection: "", herdrSection: "", compactionSection: "", roleCatalog: "", practiceCatalog: "", roleCards: [] };
	const inactivePrompt = assembleHubSystemPrompt(inactive);
	const inactiveLedger = recordHubLedger(inactivePrompt, namedHubLedgerParts(inactive));
	for (const id of ["hub/policy/dispatch", "hub/policy/verification", "hub/policy/coms", "hub/policy/workspace", "hub/policy/compaction"]) {
		assert.equal(inactiveLedger.find(entry => entry.id === id)?.chars, 0, `${id} must cost zero`);
	}
	assert.doesNotMatch(inactivePrompt, /## Roles|Practices:|Verification Contract|Peer agents|Fleet \(herdr\)|Context recovery/);

	const active = { ...representativeParts(true), compactionSection: "## Context recovery\n- request_compaction is active." };
	const activeLedger = recordHubLedger(assembleHubSystemPrompt(active), namedHubLedgerParts(active));
	assert.ok((activeLedger.find(entry => entry.id === "hub/policy/compaction")?.chars ?? 0) > 0);
	assert.equal(activeLedger.reduce((sum, entry) => sum + entry.chars, 0), assembleHubSystemPrompt(active).length);
});

test("herdr is actual, zero, or unavailable — never an enabled placeholder", () => {
	const off = representativeParts(false);
	const offLedger = recordHubLedger(assembleHubSystemPrompt(off), namedHubLedgerParts(off));
	const herdr = offLedger.find((entry) => entry.id === "hub/policy/workspace");
	assert.equal(herdr?.chars, 0);
	assert.equal(herdr?.confidence, "exact-chars");
	assert.doesNotMatch(JSON.stringify(herdr), /enabled/);
	assert.equal(assembleHubSystemPrompt(off).includes("## Fleet (herdr)"), false);
	assert.equal(assembleHubSystemPrompt(representativeParts(true)).includes("## Fleet (herdr)"), true);
});
