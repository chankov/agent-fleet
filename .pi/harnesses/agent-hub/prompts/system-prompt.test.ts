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

function fixture(overrides: { active?: CapabilityPack[]; askUser?: boolean; language?: string } = {}): HubPromptContext {
	let promptState: HubPromptState = {
		taskTier: "feature", taskTierAssumed: false,
		turnDispatchCount: 1, turnResearchCount: 2,
		taskDispatchCount: 3, taskResearchCount: 4, taskReviewRounds: 1,
		turnBudget: { maxDispatches: 8, maxResearch: 4 }, taskBudget: { wallMs: 1_800_000 },
		provisionalConfirmations: [],
	};
	const active = overrides.active ?? ALL_PACKS;
	return {
		getCapabilityResolution: () => resolution(active),
		getActiveTools: () => ["dispatch_agent", "ask_user"],
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
	assert.equal(digest(built.systemPrompt), "eeb2eeae74bfecfe1e7439a3db2a4bef12b011d92b1d6e515526b10dd082a8bb");
	assert.deepEqual(built.ledger.map(entry => entry.id), [
		"hub/policy/work-mode", "hub/policy/language", "hub/roster-header", "hub/roster/builder",
		"hub/policy/dispatch", "hub/policy/triage", "hub/policy/verification", "hub/state",
		"hub/research/recon", "hub/policy/coms", "hub/policy/workspace", "hub/policy/compaction",
		"hub/separators-and-rules", ...ALL_PACKS.map(pack => `hub/capability/${pack}`),
	]);
	assert.equal(built.ledger.reduce((sum, entry) => sum + entry.chars, 0), built.systemPrompt.length);
	assert.equal(built.systemPrompt.includes("hub/capability/"), false, "ledger stays metadata-only");
});

test("language and unavailable ask_user branch preserve exact prompt text", () => {
	const built = buildHubSystemPrompt(fixture({ active: ["core"], askUser: false, language: "Bulgarian" }));
	assert.equal(digest(built.systemPrompt), "9b458863549ef86b0ba57181fb1fb3ed7aca3a29d6e466e871fda3eb50a8b599");
	assert.match(built.systemPrompt, /ask_user is NOT available/);
	assert.match(built.systemPrompt, /Every message you\n  write to the user is Bulgarian/);
	assert.doesNotMatch(built.systemPrompt, /## Native Roster|## Verification Contract|## Peer agents|## Fleet \(herdr\)|## Context recovery/);
});
