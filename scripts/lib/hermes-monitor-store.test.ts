import test from "node:test";
import assert from "node:assert/strict";

import { MonitorPublisher } from "../../.pi/harnesses/agent-hub/monitor-publisher.ts";
import { MAX_OUTPUT_BYTES, MonitorStore } from "./hermes-monitor-store.ts";

test("store retains and returns at most 256 KiB of public UTF-8 output", () => {
	const store = new MonitorStore();
	store.createParent({
		id: "turn-output",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});
	store.appendPublicOutput("turn-output", 1, "prefix\n" + "🙂".repeat(MAX_OUTPUT_BYTES));

	const output = store.readOutput("turn-output", 1, 0);

	assert.ok(Buffer.byteLength(output.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.equal(output.truncated, true);
	assert.ok(output.sequence > 0);
	assert.deepEqual(Object.keys(output).sort(), ["firstSequence", "sequence", "text", "truncated"]);
	assert.equal(output.text.includes("\uFFFD"), false);
});

test("output reads return only public chunks newer than the caller cursor", () => {
	const store = new MonitorStore();
	store.createParent({
		id: "turn-cursor",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});
	store.appendPublicOutput("turn-cursor", 1, "first");
	const first = store.readOutput("turn-cursor", 1, 0);
	store.appendPublicOutput("turn-cursor", 1, "second");

	const advanced = store.readOutput("turn-cursor", 1, first.sequence);

	assert.equal(advanced.text, "second");
	assert.equal(advanced.sequence, 2);
});

test("fixture publisher creates a correlated parent and child then exposes only bounded public output", () => {
	const store = new MonitorStore();
	const publisher = new MonitorPublisher(store);
	const parent = publisher.publishParent({
		id: "turn-publisher",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});
	const child = publisher.publishChild({
		id: "run-publisher",
		generation: 1,
		parentId: parent.id,
		parentGeneration: parent.generation,
		specialist: "test-engineer",
		workspaceId: "workspace-001",
		hubPaneId: "pane-hub-001",
	});
	publisher.publishPublicOutput(child.id, child.generation, "Visible assistant update");

	assert.equal(store.get(child.id)?.parentId, parent.id);
	assert.deepEqual(store.readOutput(child.id, child.generation, 0), {
		text: "Visible assistant update",
		sequence: 1,
		firstSequence: 1,
		truncated: false,
	});
});
