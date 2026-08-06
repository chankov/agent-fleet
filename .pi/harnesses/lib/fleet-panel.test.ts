import test from "node:test";
import assert from "node:assert/strict";
import { createPanelResources } from "./fleet-panel.ts";

test("dispose is idempotent, closes the panel, and continues after teardown failures", () => {
	const resources = createPanelResources();
	const calls: string[] = [];
	resources.onDispose(() => calls.push("first"));
	resources.onDispose(() => { throw new Error("expected"); });
	resources.onDispose(() => calls.push("last"));
	resources.dispose();
	resources.dispose();
	assert.equal(resources.closed, true);
	assert.deepEqual(calls, ["first", "last"]);
});

test("interval callbacks stop after disposal", async () => {
	const resources = createPanelResources();
	let calls = 0;
	resources.every(5, () => calls++);
	await new Promise((resolve) => setTimeout(resolve, 25));
	resources.dispose();
	const afterDispose = calls;
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(afterDispose > 0);
	assert.equal(calls, afterDispose);
});

test("callbacks registered after disposal run exactly once immediately", () => {
	const resources = createPanelResources();
	resources.dispose();
	let calls = 0;
	resources.onDispose(() => calls++);
	resources.every(1, () => calls++);
	assert.equal(calls, 1);
});
