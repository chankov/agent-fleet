import test from "node:test";
import assert from "node:assert/strict";
import { buildContextBudgetSnapshot } from "../agent-hub/context-budget-snapshot.ts";
import { component } from "./context-budget.ts";
import { ansiTruncate, contextBudgetRows, contextBudgetTransition, renderContextBudget, type ContextBudgetViewState } from "./context-budget-view.ts";

const snapshot = buildContextBudgetSnapshot({
	window: 1000,
	usage: { input: 20 },
	systemPrompt: "prompt",
	tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool-${i}`, description: "x" })),
	planes: [{ id: "specialist/b", label: "Builder", plane: "specialist", window: 200, tokens: 40 }],
	pressure: {
		phase: "warning", pressure: "approaching", episode: 1,
		tokens: 20, contextWindow: 1000, percent: 2,
		warningPercent: 80, automaticPercent: 90, lastRecoveryOutcome: "none",
	},
});
const state = (): ContextBudgetViewState => ({ selection: { index: 0 }, expanded: new Set(), scrollOffset: 0 });
for (const [width, height] of [[40, 3], [80, 10], [160, 30]] as const) {
	test(`view is fixed-height at ${width} columns`, () => assert.equal(renderContextBudget(snapshot, state(), width, height).length, height));
}
test("view renders pressure phase, thresholds, and last recovery outcome", () => {
	const rendered = renderContextBudget(snapshot, state(), 180, 8).join("\n");
	assert.match(rendered, /pressure warning/);
	assert.match(rendered, /warn 80%/);
	assert.match(rendered, /auto 90%/);
	assert.match(rendered, /last none/);
});

test("visible rows have globally stable keys and navigation reaches children, categories, and planes", () => {
	const categories = ["system", "project", "roster", "tool", "addon", "skill", "conversation"] as const;
	const rich = buildContextBudgetSnapshot({
		ledger: categories.map(category => component({ id: `${category}/entry`, plane: "hub", category, label: category, persistence: "turn", visibility: "model-visible", confidence: "heuristic", chars: 4 })),
		planes: [
			{ id: "specialist/a", label: "Specialist", plane: "specialist", window: 100, tokens: 10 },
			{ id: "research/a", label: "Research", plane: "research", window: 100, tokens: 10 },
		],
	});
	const s = state();
	const collapsed = contextBudgetRows(rich, s.expanded);
	assert.deepEqual(collapsed.map(row => row.label), ["system", "project", "roster", "tools", "addons", "skills", "conversation", "specialist plane", "research plane"]);
	for (const row of collapsed.filter(row => row.expandable)) s.expanded.add(row.key);
	const rows = contextBudgetRows(rich, s.expanded);
	assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
	assert.ok(rows.some(row => row.label.startsWith("  ")));
	for (let i = 1; i < rows.length; i++) {
		assert.equal(contextBudgetTransition("\u001b[B", s, rich, 3), undefined);
		assert.equal(s.selection.key, rows[i].key);
		assert.ok(s.scrollOffset <= s.selection.index && s.selection.index < s.scrollOffset + 3);
	}
	contextBudgetTransition("\u001b[A", s, rich, 3);
	assert.equal(s.selection.key, rows.at(-2)?.key);
	const child = rows.find(row => row.label.startsWith("  "))!;
	s.selection = { key: child.key, index: rows.findIndex(row => row.key === child.key) };
	const expansions = new Set(s.expanded);
	contextBudgetTransition("\r", s, rich, 3);
	assert.deepEqual(s.expanded, expansions);
	contextBudgetTransition("g", s, rich, 3);
	assert.equal(s.selection.key, rows[0].key);
	contextBudgetTransition("G", s, rich, 3);
	assert.equal(s.selection.key, rows.at(-1)?.key);
	contextBudgetTransition("\u001b[5~", s, rich, 3);
	assert.ok(s.scrollOffset <= s.selection.index && s.selection.index < s.scrollOffset + 3);
	contextBudgetTransition("\u001b[6~", s, rich, 3);
	assert.ok(s.scrollOffset <= s.selection.index && s.selection.index < s.scrollOffset + 3);
	const plane = rows.find(row => row.label === "specialist plane")!;
	s.expanded.delete(plane.key);
	s.selection = { key: plane.key, index: contextBudgetRows(rich, s.expanded).findIndex(row => row.key === plane.key) };
	contextBudgetTransition("\r", s, rich, 3);
	assert.ok(s.expanded.has(plane.key));
	const reordered = { ...rich, components: [...rich.components].reverse(), planes: [...rich.planes].reverse() };
	renderContextBudget(reordered, s, 40, 4);
	assert.equal(s.selection.key, plane.key);
	assert.ok(s.scrollOffset <= s.selection.index && s.selection.index < s.scrollOffset + 2);
	assert.equal(contextBudgetTransition("r", s, rich, 3), "refresh");
	assert.equal(contextBudgetTransition("\u001b", s, rich, 3), "close");
});
test("empty and error snapshots still render fixed height", () => {
	const empty = buildContextBudgetSnapshot({ model: "provider/current" });
	const rendered = renderContextBudget(empty, state(), 40, 4);
	assert.equal(rendered.length, 4);
	assert.match(rendered[0], /provider\/current/);
});
test("ANSI truncation never splits an escape sequence", () => {
	assert.equal(ansiTruncate("\x1b[31mabcdef\x1b[0m", 3), "\x1b[31mabc\x1b[0m");
});
