import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OVERRIDES, parseAgentTeamOverrides } from "../config/overrides.ts";
import { applySessionOverrides } from "../lifecycle/session-orchestration.ts";
import type { CapabilityPack, CapabilityResolution } from "../capability-packs.ts";
import { capabilityConfirmationQuestion } from "../capability-confirmation.ts";
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
		provisionalConfirmations: [],
	};
	const active = overrides.active ?? ALL_PACKS;
	return {
		getCapabilityResolution: () => resolution(active),
		getActiveTools: () => ["dispatch_agent", ...(overrides.askUser === false ? [] : ["ask_user"])],
		getToolCatalogNotice: () => overrides.catalogNotice ?? "",
		getAgents: () => [
			{ name: "reviewer", displayName: "Reviewer", description: "Reviews.", tools: "read,bash", readOnly: true },
			{ name: "editor", displayName: "Editor", description: "Edits.", tools: "read,write" },
		],
		getResearchPersonas: () => [{ name: "researcher", displayName: "Researcher", description: "Researches.", model: "fast/model", thinking: "low" }],
		getPromptState: () => promptState,
		getWorkMode: () => "operator",
		getUserLanguage: () => overrides.language ?? "English",
		isComsReady: () => true,
		getIdentity: () => ({ name: "hub", project: "fleet" }),
		isHerdrFleetReady: () => true,
		getRulesProtocol: () => overrides.rulesProtocol ?? "",
		getDocsProtocol: () => overrides.docsProtocol ?? "",
	} as HubPromptContext;
}

test("System 1 assistance is optional across modes and tiers, with bounded fallback", () => {
	for (const mode of ["operator"] as const) {
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
	assert.match(built.systemPrompt, /`dispatch_triage`, when listed, is optional advice; never a gate or permission/);
	assert.match(built.systemPrompt, /For actual human answers use USER_ANSWER: <dispatchId> :: <question>/);
	// The filesystem tool's own description carries the stat/offset/max_bytes excerpt rule.
	assert.match(built.systemPrompt, /Choose a research helper when it adds value, not merely because the file is large/);
	assert.match(built.systemPrompt, /Never repeat an unchanged refusal/);
	assert.match(built.systemPrompt, /absence means the tier has not opened verification, not acceptance/);
	assert.match(built.systemPrompt, /Inspect|Check every return for questions/);
	assert.doesNotMatch(built.systemPrompt, /with the answer\./);
	assert.match(built.systemPrompt, /risk high; scope small; open obligations: review/);
	assert.match(built.systemPrompt, /correctness obligations are independent of tier/);
	assert.deepEqual(built.ledger.map(entry => entry.id), [
		"hub/policy/work-mode", "hub/policy/language", "hub/policy/dispatch",
		"hub/role/researcher", "hub/role/reviewer", "hub/role/editor", "hub/practices", "hub/policy/triage", "hub/policy/verification",
		"hub/policy/project", "hub/policy/coms", "hub/policy/workspace", "hub/policy/compaction",
		"hub/separators-and-rules", "hub/state", ...ALL_PACKS.map(pack => `hub/capability/${pack}`),
	]);
	assert.equal(built.ledger.reduce((sum, entry) => sum + entry.chars, 0), built.systemPrompt.length);
	assert.equal(built.systemPrompt.includes("hub/capability/"), false, "ledger stays metadata-only");
});

test("a dispatch counter change preserves the shared prefix through all Hub instructions", t => {
	const ctx = fixture({ rulesProtocol: "\n## Project rules\nRead the repository guide.\n" });
	const state = ctx.getPromptState();
	const first = buildHubSystemPrompt(ctx);
	ctx.getPromptState = () => ({ ...state, turnDispatchCount: state.turnDispatchCount + 1 });
	const second = buildHubSystemPrompt(ctx);
	let prefixLength = 0;
	while (prefixLength < first.systemPrompt.length && prefixLength < second.systemPrompt.length
		&& first.systemPrompt[prefixLength] === second.systemPrompt[prefixLength]) prefixLength++;
	t.diagnostic(`Shared prefix after changing one counter: ${prefixLength} characters`);

	const shared = first.systemPrompt.slice(0, prefixLength);
	for (const heading of ["## Verification Contract", "## Project rules", "## Peer agents (coms)", "## Fleet (herdr)", "## Context recovery", "## Hard Rules"]) {
		assert.ok(shared.includes(heading), `${heading} must precede the changed counter`);
	}
	assert.ok(shared.endsWith("turn dispatches: "));
	assert.equal(second.systemPrompt, first.systemPrompt.replace("turn dispatches: 1;", "turn dispatches: 2;"));
	assert.deepEqual(second.ledger, first.ledger, "one digit changes the state without changing its ledger size");
});

test("changing capability packs refreshes applicable instructions and ledger entries", () => {
	const ctx = fixture({ active: ["core"] });
	const core = buildHubSystemPrompt(ctx);
	ctx.getCapabilityResolution = () => resolution(["core", "fleet", "verification"]);
	const fleet = buildHubSystemPrompt(ctx);

	assert.doesNotMatch(core.systemPrompt, /## Roles|^Practices:$|## Verification Contract/m);
	assert.match(fleet.systemPrompt, /## Roles and practices/);
	assert.match(fleet.systemPrompt, /^Practices:$/m);
	assert.match(fleet.systemPrompt, /## Verification Contract/);
	assert.equal(core.ledger.find(entry => entry.id === "hub/policy/verification")?.chars, 0);
	assert.ok((fleet.ledger.find(entry => entry.id === "hub/policy/verification")?.chars ?? 0) > 0);
	assert.equal(fleet.ledger.find(entry => entry.id === "hub/capability/verification")?.label, "Capability verification: active");
	assert.equal(fleet.ledger.reduce((sum, entry) => sum + entry.chars, 0), fleet.systemPrompt.length);
	ctx.getCapabilityResolution = () => resolution(["core"]);
	assert.deepEqual(buildHubSystemPrompt(ctx), core);
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
	const withoutNotice = buildHubSystemPrompt(fixture());
	assert.equal(built.systemPrompt, withoutNotice.systemPrompt + "\n\n" + notice);
	assert.deepEqual(built.ledger.filter(entry => entry.id !== "hub/state"), withoutNotice.ledger.filter(entry => entry.id !== "hub/state"));
	assert.equal(
		built.ledger.find(entry => entry.id === "hub/state")!.chars - withoutNotice.ledger.find(entry => entry.id === "hub/state")!.chars,
		notice.length + 2,
	);
	assert.match(built.systemPrompt, /Removed: bash, read, write/);
	assert.match(built.systemPrompt, /Valid active substitute: dispatch_agent/);
	assert.match(built.systemPrompt, /Permission expansion: false/);
	assert.match(built.systemPrompt, /Unknown tool bash was refused \(1\/3\)/);
	assert.match(built.systemPrompt, /No automatic retry was performed/);
});

for (const fleet of [true, false]) for (const askUser of [true, false]) {
	test(`Hub questions follow the active catalog with fleet ${fleet ? "active" : "inactive"} and ask_user ${askUser ? "listed" : "unlisted"}`, () => {
		const ctx = fixture({ active: fleet ? ALL_PACKS : ["core"], language: fleet ? "Bulgarian" : "German" });
		ctx.getAgenticAskMode = () => "recommended";
		const tools = ["ask_system1", ...(fleet ? ["dispatch_agent", "spawn_research", "herdr_notify"] : []), ...(askUser ? ["ask_user"] : [])];
		ctx.getActiveTools = () => tools;
		const { systemPrompt } = buildHubSystemPrompt(ctx);
		const language = ctx.getUserLanguage();
		assert.ok(systemPrompt.includes(`Use **${language}** for all user-facing messages`));
		const decision = systemPrompt.split("## Decision routing\n")[1].split("\n\n")[0];
		if (askUser) {
			assert.match(decision, new RegExp(`Use \`ask_user\`.*in ${language}`));
			assert.doesNotMatch(systemPrompt, /ask in chat|use chat.*escalation/i);
		} else {
			assert.doesNotMatch(systemPrompt, /(?:call|use|with|via|replaces) `?ask_user|before `ask_user`/i);
			assert.match(decision, new RegExp(`ask in chat in ${language}`, "i"));
		}
		assert.match(decision, /wait for an explicit human answer before dependent work/i);
		assert.match(decision, /silence is not approval/i);
		assert.match(decision, /Investigate discoverable facts with available tools or focused research/);
		assert.match(decision, /Resolve routine technical choices independently/);
		assert.match(systemPrompt, /## Recommended System 1 usage/);
		if (fleet) {
			assert.match(systemPrompt, /Triage every ASK_USER\/details.questions item before escalating/);
			assert.match(systemPrompt, /Translate .*specialist questions.*Bulgarian/);
			assert.match(systemPrompt, /## Fleet \(herdr\)/);
		} else {
			assert.doesNotMatch(systemPrompt, /## Roles|## Verification Contract|## Peer agents|## Fleet \(herdr\)|## Context recovery|ORCHESTRATOR_ANSWER:/);
		}
	});
}

test("provisional confirmations use the current route and retain the recorded confirmation requirement", () => {
	const ctx = fixture({ active: ["core"], language: "Bulgarian" });
	const state = ctx.getPromptState();
	const question = capabilityConfirmationQuestion("peer");
	ctx.getPromptState = () => ({ ...state, provisionalConfirmations: [{ pack: "peer", reason: "ambiguous", question }] });
	ctx.getActiveTools = () => [];
	const unavailable = buildHubSystemPrompt(ctx).systemPrompt;
	assert.match(unavailable, /provisional confirmation: peer.*ask in chat.*recorded tool confirmation/i);
	assert.doesNotMatch(unavailable, /call ask_user exactly once|agent-hub-capability-confirmation:peer/);
	ctx.getActiveTools = () => ["ask_user"];
	const available = buildHubSystemPrompt(ctx).systemPrompt;
	assert.match(available, /provisional confirmation: peer.*ask once with `ask_user`/i);
	assert.ok(available.includes(JSON.stringify(question)));
	assert.match(available, /keep the context marker and option values/i);
	ctx.getPromptState = () => ({ ...state, provisionalConfirmations: [{ pack: "peer", reason: "ambiguous", question, pending: true }] });
	const pending = buildHubSystemPrompt(ctx).systemPrompt;
	assert.match(pending, /provisional confirmation: peer.*await the pending answer/i);
	assert.doesNotMatch(pending, /call ask_user exactly once|agent-hub-capability-confirmation:peer/);
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

test("enabled pre-dispatch advice reaches the operator without granting execution authority",()=>{
 const ctx=fixture();ctx.getTriageBeforeDispatch=()=>true;ctx.getActiveTools=()=>["dispatch_agent","dispatch_triage","ask_user"];
 const built=buildHubSystemPrompt(ctx);
 assert.match(built.systemPrompt,/Enabled System 1 pre-dispatch advice/);
 assert.match(built.systemPrompt,/independently decide whether and whom to dispatch/);
 assert.match(built.systemPrompt,/NOT an approved recommendation/);
 assert.match(built.systemPrompt,/without automatic retries/);
 assert.equal(built.ledger.reduce((sum,e)=>sum+e.chars,0),built.systemPrompt.length);
 ctx.getTriageBeforeDispatch=()=>false;assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/Enabled System 1 pre-dispatch advice/);
 ctx.getTriageBeforeDispatch=()=>true;ctx.getActiveTools=()=>["dispatch_agent"];assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/Enabled System 1 pre-dispatch advice/,"no advice without the triage tool");
});
test('D8 delivered orientation is reused without replacing exact evidence, explicit claim/risk or off/unavailable fallback',()=>{
 const ctx=fixture({active:['core']});ctx.getActiveTools=()=>['ask_system1_files'];
 const prompt=buildHubSystemPrompt(ctx).systemPrompt;
 for(const text of ['Use current delivered typed answers','not a free-form summary','Explicit proposition/risk','Unknown, insufficient, partial or stale','pre-edit reads remain mandatory','Off/unavailable continues via ordinary tools'])assert.ok(prompt.includes(text));
 ctx.getActiveTools=()=>[];assert.doesNotMatch(buildHubSystemPrompt(ctx).systemPrompt,/When D8 semanticReads is active/);
});


test("decision routing retains material questions but triages specialists first in both modes", () => {
 for (const askUser of [true, false]) for (const mode of ["operator"] as const) {
  const ctx = fixture({ askUser }); ctx.getWorkMode = () => mode;
  const prompt = buildHubSystemPrompt(ctx).systemPrompt;
  assert.match(prompt, /Resolve routine technical choices independently within the approved scope/);
  assert.match(prompt, /public compatibility contract/);
  assert.match(prompt, /Triage every ASK_USER\/details.questions item before escalating/);
  assert.match(prompt, /ORCHESTRATOR_ANSWER:/);
  assert.match(prompt, /Never fabricate a human answer/);
  assert.doesNotMatch(prompt, /For every returned ASK_USER.*ask the human|Relay every ASK_USER/);
  assert.match(prompt, /Wait for an explicit human answer before dependent work\. Silence is not approval\./);
 }
});

test("operator prompt shows the three roles with their authority, the practice catalog and local model caps (D7)", () => {
 const ctx = fixture();
 const prompt = buildHubSystemPrompt({
  ...ctx,
  getWorkMode: () => "operator",
  getAgents: () => [
   { name: "editor", displayName: "Editor", description: "Edits.", tools: "read,write", model: "omlx/Qwen" },
  ],
  getResearchPersonas: () => [{ name: "researcher", displayName: "Researcher", description: "Researches.", model: "xai/grok", thinking: "medium" }],
  getProviderLimits: () => [{ provider: "omlx", limit: 2, inFlight: 1, queued: 0 }],
 }).systemPrompt;
 assert.match(prompt, /^- `researcher` — read-only \(read\/grep\/find\/ls\), via `spawn_research`\. Default: research · xai\/grok$/m);
 assert.match(prompt, /^- `reviewer` — read-only, via `dispatch_agent`; never approves its author's work\. Default: independent-review · not installed$/m);
 assert.match(prompt, /^- `editor` — writes only inside the declared scope, via `dispatch_agent`\. Default: implementation · omlx\/Qwen$/m);
 assert.match(prompt, /An assignment is one role \(its authority\) plus `practices` \(combinable; empty: role default\) that add method and evidence, never authority\./);
 const practices = prompt.split("\nPractices:\n")[1]?.split("\n\n")[0] ?? "";
 for (const id of ["research", "architecture", "planning", "implementation", "independent-review", "testing", "security", "performance", "browser-debugging", "documentation", "release"]) {
  assert.match(practices, new RegExp(`^- \`${id}\``, "m"), id);
 }
 assert.match(practices, /^- `independent-review` \(reviewer\) — A plan feasibility/m);
 assert.match(practices, /^- `release` \(editor\) — Release preparation and readiness evidence\. Publishing needs separate permission\.$/m);
 assert.doesNotMatch(prompt, /Native Roster|team_adjust|active team|Members:|## Agents|## Research personas|not in team yet/);
 assert.match(prompt, /## When to delegate[\s\S]*Research: delegate by default[\s\S]*in parallel in one turn/);
 assert.match(prompt, /`omlx\/` at most 2 parallel runs/);
 assert.match(prompt, /local model slots in use: omlx 1\/2/);
});

test("the one operator prompt carries the delegation guide; idle caps add no slot line", () => {
 const ctx = fixture();
 const prompt = buildHubSystemPrompt({ ...ctx, getProviderLimits: () => [{ provider: "omlx", limit: 2, inFlight: 0, queued: 0 }] }).systemPrompt;
 assert.match(prompt, /## When to delegate/);
 assert.match(prompt, /`omlx\/` at most 2 parallel runs/);
 assert.doesNotMatch(prompt, /local model slots in use/);
 assert.doesNotMatch(prompt, /dispatcher agent — an orchestrator|NEVER try to execute, edit, or write/);
 const uncapped = buildHubSystemPrompt({ ...ctx, getProviderLimits: () => [] }).systemPrompt;
 assert.doesNotMatch(uncapped, /Local model concurrency/);
});

// Plan phase 7.2 (2026-11-12): in a plain folder of nested repositories the operator
// sees that the root is not a repository and which nested repositories the task uses.
test("the state capsule names the nested repositories a task uses, and only in such a workspace", () => {
 const ctx = fixture();
 const root = buildHubSystemPrompt(ctx).systemPrompt;
 assert.doesNotMatch(root, /root is not a Git repository/, "a root repository adds nothing");
 const state = ctx.getPromptState();
 ctx.getPromptState = () => ({ ...state, nestedRepositories: ["rin-docs", "ringithub"] });
 const nested = buildHubSystemPrompt(ctx).systemPrompt;
 const line = nested.split("\n").find(text => text.includes("root is not a Git repository")) ?? "";
 assert.match(line, /nested repositories rin-docs, ringithub/);
 assert.match(line, /exact paths inside one of them/);
 assert.match(line, /`run_flow` takes `repo:` naming one/);
 ctx.getPromptState = () => ({ ...state, nestedRepositories: Array.from({ length: 12 }, (_, i) => `repository-with-a-long-name-${i}`) });
 const many = buildHubSystemPrompt(ctx).systemPrompt.split("\n").find(text => text.includes("root is not a Git repository")) ?? "";
 assert.ok(many.length <= 360, `the line stays bounded (${many.length} chars)`);
 assert.match(many, /\(\+6 more\)/);
});
