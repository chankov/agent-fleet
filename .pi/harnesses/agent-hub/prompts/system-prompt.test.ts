import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OVERRIDES, parseAgentTeamOverrides } from "../config/overrides.ts";
import { applySessionOverrides } from "../lifecycle/session-orchestration.ts";
import type { CapabilityPack, CapabilityResolution } from "../capability-packs.ts";
import { buildProjectDocsProtocol, buildProjectRulesProtocol } from "../../lib/context-budget-child-prompt.ts";
import { createProjectPolicyFixture, FIXTURE_POLICY_MARKER } from "../../../../bin/test/helpers/project-policy-fixture.js";
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

function fixture(overrides: { active?: CapabilityPack[]; askUser?: boolean; language?: string; catalogNotice?: string; rulesProtocol?: string; docsProtocol?: string } = {}): HubPromptContext {
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
		getRulesProtocol: () => overrides.rulesProtocol ?? "",
		getDocsProtocol: () => overrides.docsProtocol ?? "",
	} as HubPromptContext;
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

test("System 1 assistance is optional across modes and tiers, with bounded fallback", () => {
	for (const mode of ["operator", "orchestrator"] as const) {
		for (const tier of ["trivial", "small", "feature", "project"]) {
			const ctx = fixture({ active: ["core"] });
			const state = ctx.getPromptState();
			ctx.getPromptState = () => ({ ...state, taskTier: tier });
			ctx.getWorkMode = () => mode;
			ctx.getActiveTools = () => ["ask_system1", "ask_user"];
			ctx.getAgenticAskMode = () => "recommended";
			const built = buildHubSystemPrompt(ctx);
			assert.match(built.systemPrompt, /## Recommended System 1 usage/);
			assert.match(built.systemPrompt, /Use `ask_system1` only for a concrete/i);
			assert.match(built.systemPrompt, /directly at every tier/);
			assert.doesNotMatch(built.systemPrompt, /free and fast|before reasoning\/research/);
			assert.match(built.systemPrompt, /measured accuracy, latency and successful tool use/);
			assert.match(built.systemPrompt, /Check approved agenticAsk\.include scope/);
			assert.match(built.systemPrompt, /git:tracked covers only paths in this repo's current Git index/);
			assert.match(built.systemPrompt, /source_denied is a local source\/input guard refusal, not a model judgment/);
			assert.match(built.systemPrompt, /Never bypass export denial by copying denied source\/output into state or questions/);
			assert.match(built.systemPrompt, /ordinary reading, research or independent reasoning/);
			assert.match(built.systemPrompt, /never grants authority or replaces required reading before editing/);
			assert.equal(built.ledger.reduce((sum, entry) => sum + entry.chars, 0), built.systemPrompt.length);
		}
	}
});

test("recommended instructions track current mode and active tool availability", () => {
	const ctx = fixture();
	ctx.getActiveTools = () => ["ask_system1"];
	for (const mode of ["off", "advisory", "recommended"] as const) {
		ctx.getAgenticAskMode = () => mode;
		assert.equal(buildHubSystemPrompt(ctx).systemPrompt.includes("## Recommended System 1 usage"), mode === "recommended");
	}
	ctx.getActiveTools = () => [];
	assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt, /## Recommended System 1 usage/);
	ctx.getActiveTools = () => ["ask_system1"];
	delete ctx.getAgenticAskMode;
	assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt, /## Recommended System 1 usage/);
});

test("full extracted Hub prompt preserves exact text, ordering, and ledger", () => {
	const built = buildHubSystemPrompt(fixture());
	// Intentional prose compaction; semantic guards below remain independently asserted.
	assert.ok(built.systemPrompt.indexOf("## Language") < built.systemPrompt.indexOf("## Hard Rules"));
	assert.match(built.systemPrompt, /Optionally use `dispatch_triage`/);
	assert.match(built.systemPrompt, /For actual human answers use USER_ANSWER: <dispatchId> :: <question>/);
	assert.match(built.systemPrompt, /bounded excerpts of large files/);
	assert.match(built.systemPrompt, /Never repeat an unchanged refusal/);
	assert.match(built.systemPrompt, /absence means the tier has not opened verification, not acceptance/);
	assert.match(built.systemPrompt, /Inspect|Check every return for questions/);
	assert.doesNotMatch(built.systemPrompt, /with the answer\./);
	assert.match(built.systemPrompt, /risk high; scope small; open obligations: review/);
	assert.match(built.systemPrompt, /correctness obligations are independent of tier/);
	assert.deepEqual(built.ledger.map(entry => entry.id), [
		"hub/policy/work-mode", "hub/policy/language", "hub/roster-header", "hub/roster/builder",
		"hub/policy/dispatch", "hub/policy/triage", "hub/policy/verification", "hub/policy/project", "hub/state",
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
	assert.equal(digest(built.systemPrompt), "b4e919ab243a1ae23aca47083f8e24efc1376c92b566498e1499ae95af568941");
	assert.match(built.systemPrompt, /ask_user tool is unavailable/);
	assert.match(built.systemPrompt, /Every message you\n  write to the user is Bulgarian/);
	assert.doesNotMatch(built.systemPrompt, /## Native Roster|## Verification Contract|## Peer agents|## Fleet \(herdr\)|## Context recovery/);
});

test("configured policy renders index-first for root operator and orchestrator prompts", () => {
	const project = createProjectPolicyFixture("hub-root-policy-");
	try {
		const configured = parseAgentTeamOverrides(project.cwd);
		assert.equal(project.task.includes(FIXTURE_POLICY_MARKER), false, "fixture policy is absent from the user task");
		const rulesProtocol = buildProjectRulesProtocol(configured.rulesDirs);
		const docsProtocol = buildProjectDocsProtocol(["docs/README.md"]);
		for (const active of [["core"], ALL_PACKS] as CapabilityPack[][]) {
			const built = buildHubSystemPrompt(fixture({ active, rulesProtocol, docsProtocol }));
			assert.match(built.systemPrompt, /## Project rules/);
			assert.match(built.systemPrompt, /\.ai\/rules/);
			assert.match(built.systemPrompt, /Read a listed file directly/);
			assert.match(built.systemPrompt, /index-first/);
			assert.match(built.systemPrompt, /README\.md or index\.md/);
			assert.match(built.systemPrompt, /## Project docs[\s\S]*docs\/README\.md/);
			assert.equal((built.systemPrompt.match(/## Project rules/g) ?? []).length, 1);
			assert.equal((built.systemPrompt.match(/## Project docs/g) ?? []).length, 1);
			assert.equal(built.ledger.find(entry => entry.id === "hub/policy/project")?.chars, rulesProtocol.length + docsProtocol.length);
			assert.equal(built.ledger.reduce((sum, entry) => sum + entry.chars, 0), built.systemPrompt.length);
			assert.doesNotMatch(built.systemPrompt, /reference-only|UNRELATED_ARCHIVE_SENTINEL/);
		}
	} finally { project.cleanup(); }
});

test("fresh Hub session applies canonical external refs before composing root and child policy", t => {
 const base=mkdtempSync(join(tmpdir(),"hub-external-session-"));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const cwd=join(base,"code"),docs=join(base,"docs");mkdirSync(join(cwd,".ai"),{recursive:true});mkdirSync(join(docs,"rules"),{recursive:true});writeFileSync(join(docs,"README.md"),"docs");
 writeFileSync(join(cwd,".ai/agent-fleet-overrides.md"),"## agent-hub\nrules: ../docs/rules\ndocs: ../docs/README.md\n");
 let rules:string[]=[],references:string[]=[];
 applySessionOverrides({cwd,ui:{notify(){}}} as any,parseAgentTeamOverrides(cwd),{
 setLanguage(){},setReconTimeout(){},setBudgetOverrides(){},setWatchdog(){},resetTurnCounts(){},resetTaskWindow(){},updateModeStatus(){},setProjectRules:value=>{rules=value;},setProjectDocs:value=>{references=value;},resetModelPolicy(){},getAgentDefs:()=>[],getModelProfiles:()=>({}),deleteModelProfile(){},allowedModels:()=>[],getDispatchPolicyWarnings:()=>[],setResearchPersonas(){} });
 assert.deepEqual(rules,[join(docs,"rules")]);assert.deepEqual(references,[join(docs,"README.md")]);
 const built=buildHubSystemPrompt(fixture({rulesProtocol:buildProjectRulesProtocol(rules),docsProtocol:buildProjectDocsProtocol(references)}));
 assert.ok(built.systemPrompt.includes(join(docs,"rules")));assert.match(built.systemPrompt,/absolute external references/);
});

test("missing rules and docs paths warn and continue during session override application", () => {
	const project = createProjectPolicyFixture("hub-missing-policy-");
	try {
		const notices: Array<{ message: string; level: string }> = [];
		let rules: string[] = []; let docs: string[] = [];
		const overrides = { ...DEFAULT_OVERRIDES, rulesDirs: ["missing-rules"], docsPaths: ["missing-docs"] };
		assert.doesNotThrow(() => applySessionOverrides({ cwd: project.cwd, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as any, overrides, {
			setLanguage() {}, setReconTimeout() {}, setBudgetOverrides() {}, setWatchdog() {}, resetTurnCounts() {}, resetTaskWindow() {}, updateModeStatus() {},
			setProjectRules: value => { rules = value; }, setProjectDocs: value => { docs = value; }, resetModelPolicy() {}, getAgentDefs: () => [],
			getModelProfiles: () => ({}), deleteModelProfile() {}, allowedModels: () => [], getDispatchPolicyWarnings: () => [], setResearchPersonas() {},
		}));
		assert.deepEqual(rules, ["missing-rules"]); assert.deepEqual(docs, ["missing-docs"]);
		assert.ok(notices.some(notice => notice.level === "warning" && notice.message.includes('rules folder "missing-rules" not found')));
		assert.ok(notices.some(notice => notice.level === "warning" && notice.message.includes('docs entry point "missing-docs" not found')));
	} finally { project.cleanup(); }
});

test("enabled orchestrator advice precedes dispatch without granting execution authority",()=>{
 const ctx=fixture();ctx.getTriageBeforeDispatch=()=>true;ctx.getActiveTools=()=>["dispatch_agent","dispatch_triage","ask_user"];
 const built=buildHubSystemPrompt(ctx);
 assert.match(built.systemPrompt,/Enabled System 1 pre-dispatch advice/);
 assert.match(built.systemPrompt,/independently decide whether and whom to dispatch/);
 assert.match(built.systemPrompt,/NOT an approved recommendation/);
 assert.match(built.systemPrompt,/without automatic retries/);
 assert.equal(built.ledger.reduce((sum,e)=>sum+e.chars,0),built.systemPrompt.length);
 ctx.getTriageBeforeDispatch=()=>false;assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/Enabled System 1 pre-dispatch advice/);
 ctx.getTriageBeforeDispatch=()=>true;ctx.getWorkMode=()=>"operator";assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/Enabled System 1 pre-dispatch advice/);
 ctx.getWorkMode=()=>"orchestrator";ctx.getActiveTools=()=>["dispatch_agent"];assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/Enabled System 1 pre-dispatch advice/);
});
test('D8 delivered orientation is reused without replacing exact evidence, explicit claim/risk or off/unavailable fallback',()=>{
 const ctx=fixture({active:['core']});ctx.getActiveTools=()=>['ask_system1_files'];
 const prompt=buildHubSystemPrompt(ctx).systemPrompt;
 for(const text of ['Use current delivered typed answers','not a free-form summary','Explicit proposition/risk','Unknown, insufficient, partial or stale','pre-edit reads remain mandatory','Off/unavailable continues via ordinary tools'])assert.ok(prompt.includes(text));
 ctx.getActiveTools=()=>[];assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/When D8 semanticReads is active/);
});


test("decision routing retains material questions but triages specialists first in both modes", () => {
 for (const askUser of [true, false]) for (const mode of ["operator", "orchestrator"] as const) {
  const ctx = fixture({ askUser }); ctx.getWorkMode = () => mode;
  const prompt = buildHubSystemPrompt(ctx).systemPrompt;
  assert.match(prompt, /Resolve routine technical choices independently within the approved scope/);
  assert.match(prompt, /public compatibility contract/);
  assert.match(prompt, /Triage every ASK_USER\/details.questions item before escalating/);
  assert.match(prompt, /ORCHESTRATOR_ANSWER:/);
  assert.match(prompt, /Never fabricate a human answer/);
  assert.doesNotMatch(prompt, /For every returned ASK_USER.*ask the human|Relay every ASK_USER/);
  if (!askUser) assert.match(prompt, /wait for an explicit answer; silence is not approval/);
 }
});
