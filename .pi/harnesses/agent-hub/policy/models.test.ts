import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { registerAgentModel } from "../commands/agent-model.ts";
import { registerAgentModelThinking } from "../commands/agent-model-thinking.ts";
import type { CommandContext } from "../commands/context.ts";
import type { AgentDef } from "../types.ts";
import { createModelPolicy } from "./models.ts";

const base = { description: "", systemPrompt: "", tools: "", file: "fixture.md" };
const defs: AgentDef[] = [
	{ ...base, name: "builder", model: "p/base", fallbackModel: "p/fallback", models: ["p/fast"], thinking: "high", subagents: { review: { model: "p/review" } } },
	{ ...base, name: "researcher", model: "p/research", kind: "research" },
];
function fixture() {
	let refreshes = 0;
	const policy = createModelPolicy({ getAllDefs: () => defs, getActiveDef: name => name === "builder" ? defs[0] : undefined, getResearchDefs: () => [defs[1]], refreshUi: () => { refreshes++; } });
	return { policy, refreshes: () => refreshes };
}

test("model policy preserves persona, thinking, sub-role, and late substitution precedence", () => {
	const { policy } = fixture();
	assert.deepEqual(policy.allowedModels(defs[0]), ["p/base", "p/fast"]);
	policy.setPersonaOverride("Builder", "p/fast");
	policy.setSubagentOverride("builder", "REVIEW", "p/fast");
	policy.setThinkingOverride("builder", "xhigh");
	assert.equal(policy.resolvedModel(defs[0]), "p/fast");
	assert.equal(policy.resolvedSubagentModel("Builder", "review", "p/review"), "p/fast");
	assert.equal(policy.resolvedThinking(defs[0]), "xhigh");
	assert.equal(policy.switchablePersonaDef("researcher"), defs[1]);
	assert.deepEqual(policy.allKnownModels(), ["p/base", "p/fallback", "p/fast", "p/review", "p/research"]);
});

test("session substitution validates source and target, applies to future resolutions, and resets", async () => {
	const { policy, refreshes } = fixture();
	const notices: string[] = [];
	const ui = { loadAvailable: async () => [{ spec: "p/new" }], notify: (message: string) => notices.push(message) };
	assert.equal(await policy.applySessionSubstitution("missing", "p/new", ui), false);
	assert.equal(await policy.applySessionSubstitution("p/base", "p/new", ui), true);
	assert.equal(policy.resolvedModel(defs[0]), "p/new");
	assert.equal(refreshes(), 1);
	assert.match(notices.at(-1) ?? "", /future agents spawned/);
	policy.reset();
	assert.equal(policy.resolvedModel(defs[0]), "p/base");
});

test('complete profiles cover all children, clear substitutions, and restore prior settings when leaving',()=>{
 const {policy}=fixture();
 policy.setPersonaOverride('builder','p/fast'); policy.setSubagentOverride('builder','review','p/review-before');
 const p:any={version:2,defaults:{model:'omlx/laguna',thinking:'off'},agents:{researcher:{model:'omlx/qwen'}},subagents:{builder:{review:{model:'omlx/qwen'}}},'allowed-models':['omlx/laguna','omlx/qwen'],fallback:'none',routing:'native'};
 policy.applyProfile(p);
 assert.equal(policy.resolvedModel(defs[0]),'omlx/laguna');
 assert.equal(policy.resolvedModel(defs[1]),'omlx/qwen');
 assert.equal(policy.resolvedSubagentModel('builder','review','p/review'),'omlx/qwen');
 assert.equal(policy.resolvedSubagentModel('future','new','cloud/x'),'omlx/laguna');
 assert.equal(policy.resolvedThinking(defs[0]),'off');
 assert.throws(()=>policy.setPersonaOverride('builder','cloud/x'),/refuses/);
 policy.applyProfile({builder:'p/base'});
 assert.equal(policy.resolvedSubagentModel('builder','review','p/review'),'p/review-before');
 assert.equal(policy.resolvedThinking(defs[0]),'high');
 assert.equal(policy.resolvedModel(defs[0]),'p/base');
});

test("registered selectors apply and clear sub-role models and research thinking in the shared policy", async () => {
	const { policy } = fixture();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = { registerCommand: (name, command) => { commands.set(name, command); } } satisfies Pick<ExtensionAPI, "registerCommand">;
	let choice: string | undefined;
	let refreshes = 0;
	const notices: string[] = [];
	const ctx = {
		ui: {
			select: async (_title: string, options: string[]) => {
				if (choice !== undefined) assert.ok(options.includes(choice), options.join(", "));
				return choice;
			},
			notify: (message: string) => notices.push(message),
		},
	} as ExtensionCommandContext;
	const commandCtx = {
		setWidgetContext: value => { assert.equal(value, ctx); },
		getAgentModelCompletions: () => null,
		getAgentModelThinkingCompletions: () => null,
		modelCommands: {
			policy,
			activeAgents: new Map([["builder", { def: defs[0] }]]),
			getResearchPersonas: () => [defs[1]],
			updateWidget: () => { refreshes++; },
		},
	} as CommandContext;

	registerAgentModel(pi as ExtensionAPI, commandCtx);
	registerAgentModelThinking(pi as ExtensionAPI, commandCtx);
	const model = commands.get("af-agent-model")!;
	const thinking = commands.get("af-agent-model-thinking")!;
	await model.handler("builder.review", ctx);
	assert.equal(refreshes, 0);

	choice = "p/fast";
	await model.handler(" BUILDER.REVIEW ", ctx);
	assert.equal(policy.getSubagentOverride("builder", "review"), "p/fast");
	assert.equal(policy.resolvedModel(defs[0]), "p/base");
	assert.match(notices.at(-1)!, /applies on next dispatch of builder/);

	choice = "p/review (default)";
	await model.handler("builder.review", ctx);
	assert.equal(policy.getSubagentOverride("builder", "review"), undefined);

	choice = "xhigh";
	await thinking.handler(" Researcher ", ctx);
	assert.equal(policy.resolvedThinking(defs[1]), "xhigh");
	assert.match(notices.at(-1)!, /applies on next spawn_research/);

	choice = "off (default)";
	await thinking.handler("researcher", ctx);
	assert.equal(policy.resolvedThinking(defs[1]), defs[1].thinking);
	assert.equal(refreshes, 4);
});

// ── Practice-level selection (D9) ────────────────────────────────────────────

const roleDefs = (): AgentDef[] => [
	{ ...base, name: "editor", model: "p/role", models: ["p/plan", "p/test", "p/session", "p/profile", "p/file"], thinking: "medium",
		practiceModels: { planning: { model: "p/file", thinking: "high" }, testing: { model: "p/test", thinking: "low" } } },
	{ ...base, name: "reviewer", model: "p/review", thinking: "medium" },
];
function practiceFixture(defsIn = roleDefs()) {
	const policy = createModelPolicy({ getAllDefs: () => defsIn, getActiveDef: name => defsIn.find(def => def.name === name.replace(/--p\d+$/, "")), getResearchDefs: () => [], refreshUi() {} });
	return { policy, editor: defsIn[0], reviewer: defsIn[1] };
}

test("per-practice precedence: session > profile > overrides > role file > role default", () => {
	const { policy, editor } = practiceFixture();
	const pick = () => policy.resolvedSelection(editor, ["planning"]);
	assert.deepEqual(pick(), { model: "p/file", thinking: "high", source: "practice:planning:role-file", practice: "planning" });
	policy.setConfiguredPracticeSelections({ "editor.planning": { model: "p/overrides" } });
	assert.deepEqual(pick(), { model: "p/overrides", thinking: "high", source: "practice:planning:overrides", practice: "planning" }, "overrides beat the role file; thinking still comes from the highest tier that sets it");
	policy.applyProfile({ "editor.planning": "p/profile" });
	assert.equal(pick().model, "p/profile");
	assert.equal(pick().source, "practice:planning:profile");
	policy.setPracticeOverride("editor", "planning", "p/session");
	policy.setPracticeThinkingOverride("editor", "planning", "xhigh");
	assert.deepEqual(pick(), { model: "p/session", thinking: "xhigh", source: "practice:planning:session", practice: "planning" });
	assert.deepEqual(policy.practiceDefault(editor, "planning"), { model: "p/profile", thinking: "high" }, "clearing the session choice returns to the next tier");
	policy.setPracticeOverride("editor", "planning", undefined);
	assert.equal(pick().model, "p/profile");
	// A practice with no source anywhere follows the role, as an empty assignment does.
	assert.deepEqual(policy.resolvedSelection(editor, ["implementation"]), { model: "p/role", thinking: "medium", source: "role" });
	assert.deepEqual(policy.resolvedSelection(editor), { model: "p/role", thinking: "medium", source: "role" });
	assert.equal(policy.resolvedModel(editor), "p/role", "the role-level call is unchanged");
	assert.equal(policy.resolvedThinking(editor, ["planning"]), "xhigh", "a session thinking choice stands on its own");
	policy.setPracticeThinkingOverride("editor", "planning", undefined);
	assert.equal(policy.resolvedThinking(editor, ["planning"]), "high");
});

test("the first practice in assignment order with a selection wins and later ones are ignored", () => {
	const { policy, editor } = practiceFixture();
	assert.deepEqual(policy.resolvedSelection(editor, ["implementation", "testing", "planning"]), { model: "p/test", thinking: "low", source: "practice:testing:role-file", practice: "testing" });
	assert.equal(policy.resolvedSelection(editor, ["planning", "testing"]).practice, "planning");
	// A thinking-only choice still makes its practice the winner; the model comes from the role.
	policy.setConfiguredPracticeSelections({ "editor.documentation": { thinking: "minimal" } });
	assert.deepEqual(policy.resolvedSelection(editor, ["Documentation", "planning"]), { model: "p/role", thinking: "minimal", source: "practice:documentation:overrides", practice: "documentation" });
	// Unknown ids are skipped, a parallel instance uses its base role's selections.
	assert.equal(policy.resolvedSelection(editor, ["not-a-practice", "testing"]).practice, "testing");
	const instance = { ...editor, name: "editor--p2" };
	policy.setPracticeOverride("editor", "testing", "p/session");
	assert.deepEqual(policy.resolvedSelection(instance, ["testing"]), { model: "p/session", thinking: "low", source: "practice:testing:session", practice: "testing" });
	// Substitutions apply late to a practice model too.
	policy.reset();
	assert.equal(policy.getPracticeOverride("editor", "testing"), undefined, "reset clears practice choices");
	assert.ok(policy.allKnownModels().includes("p/file"), "role-file practice models are substitution sources");
});

test("a complete profile owns practice selection; flat profiles replace each other's practice entries", () => {
	const { policy, editor } = practiceFixture();
	policy.setConfiguredPracticeSelections({ "editor.testing": { model: "p/overrides" } });
	policy.setPracticeOverride("editor", "planning", "p/session");
	const complete: any = { version: 2, defaults: { model: "omlx/a", thinking: "off" }, agents: { "editor.planning": { model: "omlx/b", thinking: "high" } }, "allowed-models": ["omlx/a", "omlx/b"], fallback: "none", routing: "native" };
	policy.applyProfile(complete);
	assert.deepEqual(policy.resolvedSelection(editor, ["planning"]), { model: "omlx/b", thinking: "high", source: "practice:planning:profile", practice: "planning" }, "session choices are saved and cleared like role overrides");
	assert.deepEqual(policy.resolvedSelection(editor, ["testing"]), { model: "omlx/a", thinking: "off", source: "role" }, "neither the overrides file nor the role file applies under a complete profile");
	assert.throws(() => policy.setPracticeOverride("editor", "planning", "cloud/x"), /refuses/);
	policy.setPracticeThinkingOverride("editor", "planning", "low");
	assert.equal(policy.resolvedSelection(editor, ["planning"]).thinking, "low");
	// Leaving the complete profile restores the session choice, then the flat profile applies.
	assert.deepEqual(policy.applyProfile({ "editor.testing": "p/profile", editor: "p/plan" }).sort(), ["editor", "editor.testing"]);
	assert.equal(policy.resolvedModel(editor, ["planning"]), "p/session");
	assert.equal(policy.resolvedSelection(editor, ["testing"]).source, "practice:testing:profile");
	assert.equal(policy.resolvedModel(editor), "p/plan");
	// A flat profile naming a practice clears that practice's session choice.
	policy.applyProfile({ "editor.planning": "p/profile" });
	assert.equal(policy.getPracticeOverride("editor", "planning"), undefined);
	assert.equal(policy.resolvedSelection(editor, ["planning"]).source, "practice:planning:profile");
	assert.equal(policy.resolvedSelection(editor, ["testing"]).source, "practice:testing:overrides", "the previous flat profile's practice entry is gone");
	// Unknown roles and practices in a flat map are skipped (validation reports them earlier).
	assert.deepEqual(policy.applyProfile({ "builder.planning": "p/x", "editor.typo": "p/x" }), []);
});

test("/af-agent-model and /af-agent-model-thinking accept <role>.<practice> and keep sub-role targets", async () => {
	const { policy, editor } = practiceFixture();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = { registerCommand: (name, command) => { commands.set(name, command); } } satisfies Pick<ExtensionAPI, "registerCommand">;
	let choice: string | undefined;
	let offered: string[] = [];
	const notices: string[] = [];
	const ctx = { ui: { select: async (_title: string, options: string[]) => { offered = options; return choice; }, notify: (message: string) => notices.push(message) } } as ExtensionCommandContext;
	const commandCtx = {
		setWidgetContext() {},
		getAgentModelCompletions: () => null,
		getAgentModelThinkingCompletions: () => null,
		modelCommands: { policy, activeAgents: new Map([["editor", { def: editor }]]), getResearchPersonas: () => [], updateWidget() {}, prefersComs: () => false },
	} as unknown as CommandContext;
	registerAgentModel(pi as ExtensionAPI, commandCtx);
	registerAgentModelThinking(pi as ExtensionAPI, commandCtx);
	const model = commands.get("af-agent-model")!;
	const thinking = commands.get("af-agent-model-thinking")!;

	choice = "p/session";
	await model.handler(" editor.Planning ", ctx);
	assert.ok(offered.includes("p/file (default, current)"), offered.join(", "));
	assert.equal(policy.getPracticeOverride("editor", "planning"), "p/session");
	assert.equal(policy.resolvedSelection(editor, ["planning"]).source, "practice:planning:session");
	assert.match(notices.at(-1)!, /editor\.planning → p\/session/i);
	choice = "p/file (default)";
	await model.handler("editor.planning", ctx);
	assert.equal(policy.getPracticeOverride("editor", "planning"), undefined, "picking the default clears the session choice");

	choice = "xhigh";
	await thinking.handler("editor.planning", ctx);
	assert.equal(policy.getPracticeThinkingOverride("editor", "planning"), "xhigh");
	assert.equal(policy.resolvedThinking(editor), "medium", "the role thinking is untouched");
	choice = "high (default)";
	await thinking.handler("editor.planning", ctx);
	assert.equal(policy.getPracticeThinkingOverride("editor", "planning"), undefined);

	// A suffix that is not a practice id stays a sub-role target.
	await model.handler("editor.recon", ctx);
	assert.match(notices.at(-1)!, /No sub-role "editor\.recon"/);
	await thinking.handler("editor.recon", ctx);
	assert.match(notices.at(-1)!, /Usage: \/af-agent-model-thinking <role>\[\.<practice>\]/);
});
