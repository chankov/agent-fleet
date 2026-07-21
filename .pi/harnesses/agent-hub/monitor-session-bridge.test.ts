import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
import { MAX_OUTPUT_BYTES } from "../../../scripts/lib/hermes-monitor-store.ts";

test("bridge emits one flat parent/child snapshot contract with cursor and ownership fields", async () => {
	const handles: unknown[] = []; const bridge = createMonitorSessionBridge({ registerOwnedProcess: (key: string, process: unknown) => handles.push({ key, process }) });
	const parent = bridge.startParent({ id: "parent", hubInstanceId: "hub", checkoutId: "checkout" });
	const child = await bridge.startChild({ key: "run", id: "child", generation: 1, parentId: parent.id, specialist: "builder", workspaceId: "workspace", hubPaneId: "pane" }, {});
	await bridge.registerOwnedProcess("run", { pid: 77, startedAt: "fake" });
	assert.deepEqual(handles, [{ key: "run", process: { pid: 77, startedAt: "fake" } }]);
	const snapshot = bridge.snapshot();
	const parentRow= snapshot.tasks.find((task:any)=>task.id === "parent"); const childRow=snapshot.tasks.find((task:any)=>task.id === "child");
	assert.deepEqual(Object.keys(childRow).sort(), ["canCancel","firstSequence","generation","hubInstanceId","hubPaneId","id","kind","outputSequence","ownerLeaseExpiresAt","ownerSessionId","parentGeneration","parentId","specialist","state","truncated","workspaceId"]);
	assert.equal(parentRow.parentId, undefined); assert.equal(childRow.parentId, "parent");
	assert.equal(childRow.workspaceId, "workspace"); assert.equal(childRow.hubPaneId, "pane"); assert.equal(childRow.canCancel, true);
	assert.equal(child.workspaceId, "workspace");
});

test("bridge appends bounded incremental output, accepts all terminal child states, and records coms late history without reopening cancelled", async () => {
	const bridge = createMonitorSessionBridge(); const parent = bridge.startParent({ id: "parent", hubInstanceId: "hub", checkoutId: "checkout" });
	await bridge.startChild({ key: "run", id: "child", generation: 1, parentId: parent.id, specialist: "builder" }, {});
	await bridge.appendOutput("run", "x".repeat(MAX_OUTPUT_BYTES + 1));
	assert.ok((await bridge.appendOutput("run", "tail")).text.endsWith("tail"));
	assert.equal((await bridge.finishChild("run", "completed")).state, "completed");
	assert.deepEqual(bridge.recordComsLateEvent("run", { sequence: 9, text: "late" }), { state: "cancelled", history: [{ sequence: 9, text: "late" }] });
});

test("bridge reset and stop clear owned data and expose no workspace-close surface", () => {
	const bridge = createMonitorSessionBridge();
	assert.equal("workspaceClose" in bridge, false);
	bridge.reset(); bridge.stop();
	assert.deepEqual(bridge.snapshot(), { tasks: [] });
});
