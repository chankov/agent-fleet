import test from "node:test";
import assert from "node:assert/strict";
import { MonitorStore } from "./hermes-monitor-store.ts";

test("store keys records by task id plus generation so a continuation cannot collide with its terminal predecessor", () => {
	const store = new MonitorStore();
	store.createParent({ id: "task", generation: 1, hubInstanceId: "hub", checkoutId: "checkout" });
	assert.doesNotThrow(() => store.createParent({ id: "task", generation: 2, hubInstanceId: "hub", checkoutId: "checkout" }));
	assert.equal(store.get("task", 1)?.generation, 1);
	assert.equal(store.get("task", 2)?.generation, 2);
});

test("retention prunes records older than seven days and beyond 200 while preserving active tasks", async () => {
	const api = await import("./hermes-monitor-store.ts") as typeof import("./hermes-monitor-store.ts") & { pruneMonitorTasks?: unknown };
	assert.equal(typeof api.pruneMonitorTasks, "function", "Slice 7 requires deterministic seven-day/200-task retention");
	const retained = (api.pruneMonitorTasks as Function)({ now: new Date("2026-01-08T00:00:00Z"), tasks: [{ id: "active", state: "running", updatedAt: "2025-01-01T00:00:00Z" }] });
	assert.deepEqual(retained.map((task: { id: string }) => task.id), ["active"]);
});
