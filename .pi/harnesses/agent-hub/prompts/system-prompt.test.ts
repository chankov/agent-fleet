import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CapabilityPack, CapabilityResolution } from "../capability-packs.ts";
import type { HubPromptContext, HubPromptState } from "./context.ts";
import { buildHubSystemPrompt } from "./system-prompt.ts";

const ALL_PACKS: CapabilityPack[] = ["core", "fleet", "verification", "peer", "workspace", "compaction"];

function resolution(active: CapabilityPack[]): CapabilityResolution {
	return {
		active,
		provisional: [],
		reasons: {
			core: "core", fleet: active.includes("fleet") ? "explicit-fleet" : "inactive",
			verification: active.includes("verification") ? "explicit-verification" : "inactive",
			peer: active.includes("peer") ? "explicit-peer" : "inactive",
			workspace: active.includes("workspace") ? "explicit-workspace" : "inactive",
			compaction: active.includes("compaction") ? "explicit-compaction" : "inactive",
		},
		confirmationRequired: [],
		nextTaskPacks: active,
	};
}

function fixture(overrides: { active?: CapabilityPack[]; askUser?: boolean; language?: string; catalogNotice?: string } = {}): HubPromptContext {
	let promptState: HubPromptState = {
		taskTier: "feature", taskTierAssumed: false, processRisk: "high", processScope: "small", processOpen: ["review"],
		turnDispatchCount: 1, turnResearchCount: 2,
		taskDispatchCount: 3, taskResearchCount: 4, taskReviewRounds: 1,
		turnBudget: { maxDispatches: 8, maxResearch: 4 }, taskBudget: { wallMs: 1_800_000 },
		provisionalConfirmations: [],
	};
	const active = overrides.active ?? ALL_PACKS;
	return {
		getCapabilityResolution: () => resolution(active),
		getActiveTools: () => ["dispatch_agent", "ask_user"],
		getToolCatalogNotice: () => overrides.catalogNotice ?? "",
		getAgents: () => [{ name: "builder", displayName: "Builder", description: "Builds changes.", tools: "read,write" }],
		getResearchPersonas: () => [{ name: "recon", displayName: "Recon", description: "Maps code.", model: "fast/model", thinking: "low" }],
		getPromptState: () => promptState,
		getWorkMode: () => "orchestrator",
		getActiveTeamName: () => "Delivery",
		getUserLanguage: () => overrides.language ?? "English",
		isAskUserAvailable: () => overrides.askUser ?? true,
		isComsReady: () => true,
		getIdentity: () => ({ name: "hub", project: "fleet" }),
		isHerdrFleetReady: () => true,
	};
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

test("full extracted Hub prompt preserves exact text, ordering, and ledger", () => {
	const built = buildHubSystemPrompt(fixture());
	assert.equal(digest(built.systemPrompt), "c6c2abd451accc6752aa51686e171cd085231352ef77087ddae75e93f5a1963c");
	assert.match(built.systemPrompt, /risk high; scope small; open obligations: review/);
	assert.match(built.systemPrompt, /correctness obligations are independent of tier/);
	assert.deepEqual(built.ledger.map(entry => entry.id), [
		"hub/policy/work-mode", "hub/policy/language", "hub/roster-header", "hub/roster/builder",
		"hub/policy/dispatch", "hub/policy/triage", "hub/policy/verification", "hub/state",
		"hub/research/recon", "hub/policy/coms", "hub/policy/workspace", "hub/policy/compaction",
		"hub/separators-and-rules", ...ALL_PACKS.map(pack => `hub/capability/${pack}`),
	]);
	assert.equal(built.ledger.reduce((sum, entry) => sum + entry.chars, 0), built.systemPrompt.length);
	assert.equal(built.systemPrompt.includes("hub/capability/"), false, "ledger stays metadata-only");
});

test("trusted tool catalog producer and refusal state survive the production prompt pipeline", async () => {
	const catalog = await import("../tool-catalog-state.ts");
	const refusals = await import("../unknown-tool-counter.ts");
	assert.ok(refusals.unknownToolNotice, "missing production unknown-tool notice formatter");
	const delta = catalog.emitToolCatalogDelta({ fromMode: "operator", toMode: "orchestrator", previous: ["bash", "read", "write"], next: ["dispatch_agent", "spawn_research"] });
	const counter = refusals.createUnknownToolCounter({ limit: 3 });
	const [diagnostic] = refusals.observeUnknownToolCalls({
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "pwd" } }] },
		catalog: catalog.catalogSnapshot("orchestrator", delta.available), taskId: "task", counter, seenCallIds: new Set<string>(),
	});
	const notice = [catalog.toolCatalogNotice(delta), refusals.unknownToolNotice(diagnostic)].join("\n");
	const built = buildHubSystemPrompt(fixture({ catalogNotice: notice }));
	assert.match(built.systemPrompt, /Removed: bash, read, write/);
	assert.match(built.systemPrompt, /Valid active substitute: dispatch_agent/);
	assert.match(built.systemPrompt, /Permission expansion: false/);
	assert.match(built.systemPrompt, /Unknown tool bash was refused \(1\/3\)/);
	assert.match(built.systemPrompt, /No automatic retry was performed/);
});

test("language and unavailable ask_user branch preserve exact prompt text", () => {
	const built = buildHubSystemPrompt(fixture({ active: ["core"], askUser: false, language: "Bulgarian" }));
	assert.equal(digest(built.systemPrompt), "f74cc63bcfe34a1b6cd4271e50cbf051082b1f427340d893f59ebcfda809a15a");
	assert.match(built.systemPrompt, /ask_user is NOT available/);
	assert.match(built.systemPrompt, /Every message you\n  write to the user is Bulgarian/);
	assert.doesNotMatch(built.systemPrompt, /## Native Roster|## Verification Contract|## Peer agents|## Fleet \(herdr\)|## Context recovery/);
});
