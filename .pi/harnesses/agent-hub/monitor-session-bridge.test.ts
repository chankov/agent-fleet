import assert from "node:assert/strict";
import test from "node:test";

import { MAX_OUTPUT_BYTES } from "../../../scripts/lib/hermes-monitor-store.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";

const eventIdentity = { profileKey: "a".repeat(64), hubInstanceId: "hub-test" };

test("bridge emits one flat parent/child snapshot contract with cursor and ownership fields", async () => {
	const handles: unknown[] = [];
	const bridge = createMonitorSessionBridge({ registerOwnedProcess: (key: string, process: unknown) => handles.push({ key, process }) });
	const parent = bridge.startParent({ id: "parent", hubInstanceId: "hub", checkoutId: "checkout" });
	const child = await bridge.startChild({ key: "run", id: "child", generation: 1, parentId: parent.id, specialist: "builder", workspaceId: "workspace", hubPaneId: "pane" }, {});
	await bridge.registerOwnedProcess("run", { pid: 77, startedAt: "fake" });
	assert.deepEqual(handles, [{ key: "run", process: { pid: 77, startedAt: "fake" } }]);
	const snapshot = bridge.snapshot();
	const parentRow = snapshot.tasks.find((task: any) => task.id === "parent");
	const childRow = snapshot.tasks.find((task: any) => task.id === "child");
	assert.equal(parentRow.parentId, undefined);
	assert.equal(childRow.parentId, "parent");
	assert.equal(child.workspaceId, "workspace");
	assert.equal(childRow.canCancel, true);
});

test("bridge publishes durable material transitions, output advances, and completed turns with real correlation", async () => {
	const events: any[] = [];
	const bridge = createMonitorSessionBridge({ events: { latestSequence: () => 0, append: (event: any) => events.push(event) }, ...eventIdentity });
	bridge.setCurrentOwner({ ownerSessionId: "owner", updateActive: true });
	const parent = bridge.startParent({ id: "parent", hubInstanceId: "hub-test", checkoutId: "checkout" });
	await bridge.startChild({ key: "run", id: "child", generation: 1, parentId: parent.id, specialist: "builder" }, {});
	await bridge.appendOutput("run", "progress");
	await bridge.finishChild("run", "blocked");
	bridge.finishParent(parent.id);
	assert.deepEqual(events.map(event => event.kind), ["hub.turn_started", "task.started", "task.output_advanced", "task.state_changed", "task.state_changed", "hub.turn_completed"]);
	const blocked = events.find(event => event.kind === "task.state_changed" && event.task.toState === "blocked");
	assert.equal(blocked.task.fromState, "starting");
	assert.equal(blocked.profileKey, eventIdentity.profileKey);
	assert.equal(blocked.hubInstanceId, eventIdentity.hubInstanceId);
	assert.match(blocked.eventId, /^hub-test:/);
});

test("bridge publishes concrete owner lease and hub capability facts without placeholder identities", () => {
	const events: any[] = [];
	const bridge = createMonitorSessionBridge({ events: { latestSequence: () => 0, append: (event: any) => events.push(event) }, ...eventIdentity });
	bridge.publishHubEvent("hub.capability_changed", { capabilities: { events: true, invoke: true } });
	assert.equal(events.length, 0, "unregistered ownership must never publish a placeholder identity");
	bridge.setCurrentOwner({ ownerSessionId: "owner-1", ownerLeaseExpiresAt: "2026-01-01T00:00:00.000Z", updateActive: true });
	bridge.publishHubEvent("hub.capability_changed", { capabilities: { events: true, invoke: true } });
	assert.deepEqual(events.map(event => event.kind), ["owner.lease_changed", "hub.capability_changed"]);
	assert.ok(events.every(event => event.ownerId === "owner-1"));
});

test("bridge appends bounded incremental output and records coms late history without reopening cancelled", async () => {
	const bridge = createMonitorSessionBridge();
	const parent = bridge.startParent({ id: "parent", hubInstanceId: "hub", checkoutId: "checkout" });
	await bridge.startChild({ key: "run", id: "child", generation: 1, parentId: parent.id, specialist: "builder" }, {});
	await bridge.appendOutput("run", "x".repeat(MAX_OUTPUT_BYTES + 1));
	assert.ok((await bridge.appendOutput("run", "tail")).text.endsWith("tail"));
	assert.equal((await bridge.finishChild("run", "completed")).state, "completed");
	assert.deepEqual(bridge.recordComsLateEvent("run", { sequence: 9, text: "late" }), { state: "cancelled", history: [{ sequence: 9, text: "late" }] });
});

test("bridge reset and stop clear owned data and expose no workspace-close surface", () => {
	const bridge = createMonitorSessionBridge();
	assert.equal("workspaceClose" in bridge, false);
	bridge.reset();
	bridge.stop();
	assert.deepEqual(bridge.snapshot(), { tasks: [] });
});
