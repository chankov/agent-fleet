import test from "node:test";
import assert from "node:assert/strict";
import { buildContextBudgetSnapshot, collectContextBudgetSnapshot } from "./context-budget-snapshot.ts";

const ledger = [{ id: "hub/intro", plane: "hub" as const, category: "system" as const, label: "Hub intro", persistence: "turn" as const, visibility: "model-visible" as const, confidence: "exact-chars" as const, chars: 6, estimatedTokens: 2 }];

test("real Pi ContextUsage, ToolInfo, SlashCommandInfo and post-compaction SessionEntry shapes are accounted", () => {
	const snapshot = collectContextBudgetSnapshot({
		model: { id: "provider/model", contextWindow: 999 },
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		getSystemPrompt: () => "prompt",
		getSystemPromptOptions: () => ({ appendSystemPrompt: "excluded", skills: [{ name: "planning", description: "skill metadata" }], contextFiles: [{ path: "AGENTS.md", content: "# agents" }] }),
		sessionManager: { buildContextEntries: () => [
			{ type: "compaction", id: "c", parentId: null, timestamp: "", summary: "summary", firstKeptEntryId: "u", tokensBefore: 200 },
			{ type: "message", id: "u", parentId: "c", timestamp: "", message: { role: "user", content: "hello" } },
			{ type: "message", id: "a", parentId: "u", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 90, cacheRead: 20, cacheWrite: 3, output: 4, reasoning: 1, cost: 0.12 } } },
			{ type: "custom", id: "x", parentId: "a", timestamp: "", customType: "not-in-context", data: "must not count" },
		] },
	}, {
		ledger,
		tools: [{ name: "active", description: "d", parameters: { nested: { x: "x" } }, promptGuidelines: "guide", sourceInfo: { source: "extension", path: "/tool.ts", scope: "workspace", origin: "extension" } }, { name: "inactive", description: "no", parameters: {}, sourceInfo: { source: "extension", path: "/no.ts" } }],
		activeToolNames: ["active"],
		commands: [{ name: "af-context", description: "diagnostic", source: "extension", sourceInfo: { source: "extension", path: "/command.ts" } }],
	});
	assert.equal(snapshot.model, "provider/model");
	assert.equal(snapshot.hub.summary.measuredTokens, 100);
	assert.equal(snapshot.hub.summary.window, 1000);
	assert.ok(snapshot.components.some(x => x.id === "tool/active"));
	assert.ok(!snapshot.components.some(x => x.id === "tool/inactive"));
	assert.equal(snapshot.components.find(x => x.id === "addon/command/af-context")?.adjustedTokens, 0);
	assert.equal(snapshot.components.find(x => x.id === "pi/appendSystemPrompt")?.visibility, "loaded-excluded");
	assert.equal(snapshot.components.find(x => x.id === "pi/contextFiles/AGENTS.md")?.visibility, "loaded-excluded");
	assert.ok(snapshot.components.some(x => x.id === "conversation/compaction"));
	assert.ok(snapshot.components.some(x => x.id === "conversation/user"));
	assert.ok(!snapshot.components.some(x => x.id === "conversation/custom"));
	assert.deepEqual(snapshot.usage, { input: 90, cacheRead: 20, cacheWrite: 3, output: 4, reasoning: 1, cost: 0.12, total: 100 });
	assert.ok((snapshot.hub.summary.residualTokens ?? -1) >= 0);
	assert.equal(snapshot.hub.summary.attributedTokens + (snapshot.hub.summary.residualTokens ?? 0), 100);
	assert.doesNotMatch(JSON.stringify(snapshot), /hello|answer|diagnostic|must not count/);
});

test("compacted sessions use Pi's active branch rather than discarded raw history", () => {
	const snapshot = collectContextBudgetSnapshot({
		sessionManager: {
			getEntries: () => [{ type: "message", message: { role: "user", content: "discarded raw history" } }],
			buildContextEntries: () => ({ entries: [{ type: "compaction", summary: "active summary" }, { type: "message", message: { role: "user", content: "kept" } }] }),
		},
	});
	assert.equal(snapshot.components.find(x => x.id === "conversation/compaction")?.chars, "active summary".length);
	assert.equal(snapshot.components.find(x => x.id === "conversation/user")?.chars, "kept".length);
	assert.doesNotMatch(JSON.stringify(snapshot), /discarded raw history/);
});

test("percentage-only peers survive without a fabricated dispatcher denominator", () => {
	const snapshot = buildContextBudgetSnapshot({ planes: [
		{ id: "peer/p", label: "Peer", plane: "peer", model: "remote/model", percent: 37, attribution: "unavailable" },
		{ id: "specialist/s", label: "Specialist", plane: "specialist", window: 200, tokens: 100, projectionParts: [{ id: "persona", category: "persona", label: "Full persona", chars: 40 }, { id: "tools", category: "tool", label: "Tools", chars: 20 }] },
		{ id: "research/r", label: "Research", plane: "research", window: 400, tokens: 40, projectionChars: 20 },
		{ id: "delegate/d", label: "Delegate", plane: "delegate", window: 50, tokens: 10, projectionChars: 0, attribution: "unavailable" },
		{ id: "specialist/inactive", label: "Inactive", plane: "specialist", window: 1000, projectionChars: 80 },
	] });
	assert.equal(snapshot.planes[0].summary.measuredTokens, undefined);
	assert.equal(snapshot.planes[0].summary.window, undefined);
	assert.equal(snapshot.planes[0].summary.occupancyPercent, 37);
	assert.equal(snapshot.planes[0].components[0].confidence, "unavailable");
	assert.deepEqual(snapshot.planes.slice(1).map(p => p.summary.occupancyPercent), [50, 10, 20, undefined]);
	assert.equal(snapshot.planes[1].components.length, 2, "cold-start projection retains persona and tools separately");
});

test("pre-first-turn snapshots still account Hub ledger, tools, skills, and residual", () => {
	const snapshot = collectContextBudgetSnapshot({
		model: { id: "provider/model", contextWindow: 400 },
		getContextUsage: () => ({ tokens: 40, contextWindow: 400, percent: 10 }),
		getSystemPromptOptions: () => ({ skills: [{ name: "planning" }] }),
		sessionManager: { buildContextEntries: () => [] },
	}, {
		ledger,
		tools: [{ name: "dispatch_agent", description: "d", parameters: {} }],
		activeToolNames: ["dispatch_agent"],
		commands: [{ name: "af-context", description: "diag" }],
	});
	assert.ok(snapshot.components.some(x => x.id === "hub/intro"));
	assert.ok(snapshot.components.some(x => x.id === "tool/dispatch_agent"));
	assert.ok(snapshot.components.some(x => x.id === "skill/planning"));
	assert.ok(snapshot.components.some(x => x.id === "addon/command/af-context"));
	assert.ok(!snapshot.components.some(x => x.id.startsWith("conversation/")));
	assert.ok((snapshot.hub.summary.residualTokens ?? -1) >= 0);
	assert.ok(["exact-chars", "heuristic", "provider-scaled", "provider-total", "unavailable"].includes(snapshot.hub.residual?.confidence ?? snapshot.components.find(c => c.category === "unattributed")?.confidence ?? "heuristic"));
});

test("known local delegates project standing parts; unresolved peers stay unavailable", () => {
	const snapshot = buildContextBudgetSnapshot({
		planes: [
			{ id: "delegate/known", label: "scout", plane: "delegate", model: "local/model", window: 100, projectionParts: [{ id: "delegate-protocol", category: "protocol", label: "Resolved delegate role protocol", chars: 40 }, { id: "child-tools", category: "tool", label: "Resolved delegate tools", chars: 20 }, { id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: 8 }], attribution: "projected" },
			{ id: "peer/remote", label: "remote", plane: "peer", percent: 22, attribution: "unavailable" },
		],
	});
	assert.equal(snapshot.planes[0].components.length, 3);
	assert.ok(snapshot.planes[0].components.every(c => c.confidence !== "unavailable"));
	assert.equal(snapshot.planes[1].components[0].confidence, "unavailable");
	assert.equal(snapshot.planes[1].summary.window, undefined);
	assert.equal(snapshot.planes[1].summary.occupancyPercent, 22);
});

test("collector invokes only documented read surfaces", () => {
	let sends = 0;
	collectContextBudgetSnapshot({ getContextUsage: () => ({ tokens: null, contextWindow: 10, percent: null }), getSystemPrompt: () => "x", getSystemPromptOptions: () => ({}), getActiveTools: () => [], getAllTools: () => [], getCommands: () => [], sessionManager: { buildContextEntries: () => [] }, sendMessage: () => sends++ });
	assert.equal(sends, 0);
});
