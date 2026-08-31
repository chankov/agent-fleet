import test from "node:test";
import assert from "node:assert/strict";
import { createCompletionPresentation } from "./completions.ts";
import { registerInputShortcuts } from "./shortcuts.ts";
import { createPoolPresentation } from "../ui/pool.ts";

const def = { name: "builder", subagents: { verify: { model: "p/v" } } };

test("completion presentation preserves agents, delegates, research, models, substitutions, and peers", () => {
	const completion = createCompletionPresentation({
		getAgents: () => [{ def, status: "idle", delegations: new Map([["v", { id: "verify-1", status: "running" }]]) }],
		getResearch: () => [{ id: 2, def: { name: "researcher" }, persona: true, status: "done" }],
		getResearchPersonas: () => [{ name: "researcher" }], getModelProfiles: () => ({ fast: { builder: "p/m" } }),
		getPeers: () => [{ name: "peer", purpose: "review", model: "p/m" }], displayName: name => name.toUpperCase(), shortModel: model => model ?? "",
		resolvedModel: () => "p/r", resolvedThinking: () => "high", resolveThinkingLevel: value => value ?? "off",
		resolvedSubagentModel: () => "p/v2", getSubagentOverride: () => "p/v2", getSubstitutionSources: () => [{ spec: "p/m", label: "p/m → p/n" }],
	});
	assert.deepEqual(completion.zoom("")?.map(item => item.value), ["builder", "r2", "verify-1"]);
	assert.deepEqual(completion.agentsKill("")?.map(item => item.value), ["builder", "r2", "all"]);
	assert.equal(completion.agentModels("builder.verify")?.[0].label, "builder.verify — p/v2 (switched)");
	assert.equal(completion.agentThinking("research")?.[0].label, "RESEARCHER (research) — high");
	assert.equal(completion.modelProfiles("fast")?.[0].value, "fast");
	assert.equal(completion.substitutions("p/")?.[0].label, "p/m → p/n");
	assert.equal(completion.comsPeers("peer")?.[0].label, "peer — review");
});

test("shortcut registrar preserves routing and compact marker behavior", async () => {
	const handlers = new Map<string, (ctx: any) => any>();
	let marked: string | null = null; const calls: string[] = [];
	registerInputShortcuts({ registerShortcut: (key: string, spec: any) => handlers.set(key, spec.handler) } as any, {
		setWidgetContext: () => calls.push("context"), openFleetDashboard: async () => { calls.push("dashboard"); }, workModeStatusText: () => "mode", openWorkModePicker: async () => { calls.push("mode"); },
		isCompact: () => true, toggleCompact: () => "off", refreshWidgets: () => calls.push("refresh"), getSwitchableKeys: () => ["a", "b"],
		getMarkedAgent: () => marked, setMarkedAgent: key => { marked = key; }, clampMarker: () => {}, openMarkedAgent: async (_ctx, key) => { calls.push(`open:${key}`); return true; },
	});
	const ctx = { hasUI: true, ui: { select() {}, notify() {} } };
	assert.deepEqual(Array.from(handlers.keys()), ["alt+a", "alt+m", "alt+shift+a", "alt+]", "alt+[", "alt+\\"]);
	handlers.get("alt+]")!(ctx); assert.equal(marked, "a");
	await handlers.get("alt+\\")!(ctx); assert.ok(calls.includes("open:a"));
});

test("pool presentation renders pending peers and keeps compact gating", () => {
	let compact = true;
	const pool = createPoolPresentation({ getIdentity: () => ({ session_id: "self", name: "hub", color: "#fff", project: "p" }), getDisplayProject: () => "p", includeExplicitPeers: () => false,
		getPeerCards: () => new Map(), readProjectEntries: () => [{ session_id: "peer", name: "alpha", model: "p/m", purpose: "review", color: "#123", project: "p", endpoint: "x", pid: 1, started_at: "", explicit: false } as any], readAllEntries: () => [], isCompact: () => compact, truncate: (text, width) => text.slice(0, width) });
	const theme = { fg: (_color: string, text: string) => text };
	assert.match(pool.render(80, theme).join("\n"), /alpha[\s\S]*review/);
	compact = false; assert.deepEqual(pool.render(80, theme), []);
});
