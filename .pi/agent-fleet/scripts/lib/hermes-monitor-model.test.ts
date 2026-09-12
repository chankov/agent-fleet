import test from "node:test";
import assert from "node:assert/strict";

import {
	createChildTask,
	createParentTask,
	continueTask,
	transitionTask,
	validateMonitorEvent,
	validateMonitorInvoke,
	normalizeIngressTaskState,
} from "./hermes-monitor-model.ts";

const TERMINAL_STATES = ["completed", "blocked", "failed", "cancelled", "orphaned"] as const;

function parentTask(id = "turn-001") {
	return createParentTask({ id, generation: 1, hubInstanceId: "hub-a", checkoutId: "checkout-a" });
}

function childTask(id: string, parent: any) {
	return createChildTask({
		id,
		generation: 1,
		parentId: parent.id,
		parentGeneration: parent.generation,
		specialist: "builder",
		workspaceId: "workspace-001",
		hubPaneId: "pane-hub-001",
	});
}

function validEvent() {
	return {
		schema: "agent-fleet.monitor-event",
		schemaVersion: 1,
		eventId: "hub-a:1",
		eventSequence: 1,
		profileKey: "sha256:abc",
		hubInstanceId: "hub-a",
		ownerId: "owner-a",
		occurredAt: "2026-01-01T00:00:00.000Z",
		kind: "task.state_changed",
		task: { id: "task-a", generation: 1, toState: "running", outputSequence: 2 },
		materialKey: "task:task-a:1:running",
	};
}

function validInvoke() {
	return {
		requestId: "request-a",
		taskId: "task-a",
		generation: 1,
		action: "request_verification",
		parameters: { assertionIds: ["A1"], evidenceEventIds: ["hub-a:1"] },
		basis: { deviation: "verification_gap", judgment: "confirmed" },
	};
}

test("parent and concurrent child generations have stable distinct IDs and hierarchy", () => {
	const parent = parentTask();

	const first = childTask("run-001", parent);
	const second = childTask("run-002", parent);

	assert.equal(parent.id, "turn-001");
	assert.equal(first.parentId, parent.id);
	assert.equal(first.generation, 1);
	assert.notEqual(first.id, second.id, "concurrent children never share an id");
	assert.equal(first.workspaceId, "workspace-001");
	assert.equal(first.hubPaneId, "pane-hub-001");
});

test("starting tasks can run and complete but terminal tasks cannot mutate", () => {
	const task = parentTask("turn-terminal");

	const completed = transitionTask(transitionTask(task, "running"), "completed");

	assert.equal(completed.state, "completed");
	assert.throws(() => transitionTask(completed, "running"), /terminal task/);
});

test("blocked, failed, cancelled, and orphaned generations are terminal", () => {
	const task = parentTask("turn-terminal-states");

	for (const state of TERMINAL_STATES) {
		assert.throws(() => transitionTask(transitionTask(task, state), "running"), /terminal task/, state);
	}
});

test("continuing a blocked task opens the next generation in starting", () => {
	const blocked = transitionTask(parentTask("turn-continue"), "blocked");

	assert.deepEqual(continueTask(blocked), { ...blocked, generation: 2, state: "starting" });
});

test("the versioned event contract rejects unsafe sequences, generations, and states", () => {
	const event = validateMonitorEvent(validEvent());

	assert.equal(event?.eventSequence, 1);
	assert.equal(validateMonitorEvent({ ...event, eventSequence: 0 }), null, "sequences start at 1");
	assert.equal(validateMonitorEvent({ ...event, task: { ...event!.task, generation: 0 } }), null, "generations start at 1");
	assert.equal(validateMonitorEvent({ ...event, task: { ...event!.task, toState: "done" } }), null, "legacy done is not a contract state");
});

test("the typed invoke contract admits closed actions and rejects unsafe parameters", () => {
	const invoke = validateMonitorInvoke(validInvoke());

	assert.equal(invoke?.action, "request_verification");
	assert.equal(validateMonitorInvoke({ ...invoke, action: "shell" }), null, "shell is not a typed action");
	assert.equal(
		validateMonitorInvoke({ ...invoke, parameters: { ...invoke!.parameters, instruction: "x".repeat(1025) } }),
		null,
		"an oversized instruction is refused",
	);
});

test("legacy done is mapped to completed only at ingress", () => {
	assert.equal(normalizeIngressTaskState("done"), "completed");
});
