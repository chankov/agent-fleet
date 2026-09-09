import test from "node:test";
import assert from "node:assert/strict";
import { createCompletionPresentation } from "./completions.ts";
import { registerInputShortcuts } from "./shortcuts.ts";
import { createPoolPresentation } from "../ui/pool.ts";

const def = { name: "builder", subagents: { verify: { model: "p/v" } } };

test("completion presentation preserves agents, delegates, research, models, substitutions, and peers", () => {
	const completion = createCompletionPresentation({
		getAgents: () => [{ def, status: "idle", delegations: new Map([["v", { id: "verify-1", status: "running" }]]) }],
		getResearch: () => [{ id: 2, def: { name: "researcher" }, persona: true, status: "running" }],
		getResearchPersonas: () => [{ name: "researcher" }], getModelProfiles: () => ({ fast: { builder: "p/m" } }),
		getPeers: () => [{ name: "peer", purpose: "review", model: "p/m" }], displayName: name => name.toUpperCase(), shortModel: model => model ?? "",
		resolvedModel: () => "p/r", resolvedThinking: () => "high", resolveThinkingLevel: value => value ?? "off",
		resolvedSubagentModel: () => "p/v2", getSubagentOverride: () => "p/v2", getSubstitutionSources: () => [{ spec: "p/m", label: "p/m → p/n" }],
	});
	assert.deepEqual(completion.zoom("")?.map(item => item.value), ["builder", "r2", "verify-1"]);
	assert.deepEqual(completion.agentsKill("")?.map(item => item.value), ["builder", "r2", "all"]);
	assert.deepEqual(completion.subagentTargets("")?.map(item => item.value), ["builder"]);
	assert.equal(completion.agentModels("builder.verify")?.[0].label, "builder.verify — p/v2 (switched)");
	assert.equal(completion.agentThinking("research")?.[0].label, "RESEARCHER (research) — high");
	assert.equal(completion.modelProfiles("fast")?.[0].value, "fast");
	assert.equal(completion.substitutions("p/")?.[0].label, "p/m → p/n");
	assert.equal(completion.comsPeers("peer")?.[0].label, "peer — review");
});

test("shortcut registrar preserves fleet and work-mode routing", async () => {
	const handlers = new Map<string, (ctx: any) => any>();
	const calls: string[] = [];
	registerInputShortcuts({ registerShortcut: (key: string, spec: any) => handlers.set(key, spec.handler) } as any, {
		setWidgetContext: () => calls.push("context"), openFleetDashboard: async () => { calls.push("dashboard"); }, workModeStatusText: () => "mode", openWorkModePicker: async () => { calls.push("mode"); },
	});
	const ctx = { hasUI: true, ui: { select() {}, notify() {} } };
	assert.deepEqual(Array.from(handlers.keys()), ["alt+a", "alt+m"]);
	await handlers.get("alt+a")!(ctx);
	assert.ok(calls.includes("dashboard"));
});

test("pool presentation renders pending peers without compact gating", () => {
	const pool = createPoolPresentation({ getIdentity: () => ({ session_id: "self", name: "hub", color: "#fff", project: "p" }), getDisplayProject: () => "p", includeExplicitPeers: () => false,
		getPeerCards: () => new Map(), readProjectEntries: () => [{ session_id: "peer", name: "alpha", model: "p/m", purpose: "review", color: "#123", project: "p", endpoint: "x", pid: 1, started_at: "", explicit: false } as any], readAllEntries: () => [], truncate: (text, width) => text.slice(0, width) });
	const theme = { fg: (_color: string, text: string) => text };
	assert.match(pool.render(80, theme).join("\n"), /alpha[\s\S]*review/);
});

test("pool header shows the session project before its name, independently of discovery scope", () => {
	const pool = createPoolPresentation({
		getIdentity: () => ({ session_id: "self", name: "orchestrator", color: "#ffffff", project: "test" }),
		getDisplayProject: () => "*", includeExplicitPeers: () => false,
		getPeerCards: () => new Map(), readProjectEntries: () => [], readAllEntries: () => [],
		truncate: (text, width) => text.slice(0, width),
	});
	const theme = { fg: (_color: string, text: string) => text };
	const plainHeader = (width: number) => pool.render(width, theme)[0].replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plainHeader(80), /━project: test━━━ orchestrator ━┓$/);
	assert.match(plainHeader(30), / orchestrator ━┓$/);
	assert.doesNotMatch(plainHeader(30), /project:/);
	for (let width = 0; width <= 100; width++) assert.ok(plainHeader(width).length <= width);
});
