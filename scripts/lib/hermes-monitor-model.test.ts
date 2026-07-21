import test from "node:test";
import assert from "node:assert/strict";

import {
	createChildTask,
	createParentTask,
	continueTask,
	transitionTask,
} from "./hermes-monitor-model.ts";

test("parent and concurrent child generations have stable distinct IDs and hierarchy", () => {
	const parent = createParentTask({
		id: "turn-001",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});
	const firstChild = createChildTask({
		id: "run-001",
		generation: 1,
		parentId: parent.id,
		parentGeneration: parent.generation,
		specialist: "builder",
		workspaceId: "workspace-001",
		hubPaneId: "pane-hub-001",
	});
	const secondChild = createChildTask({
		id: "run-002",
		generation: 1,
		parentId: parent.id,
		parentGeneration: parent.generation,
		specialist: "builder",
		workspaceId: "workspace-001",
		hubPaneId: "pane-hub-001",
	});

	assert.equal(parent.id, "turn-001");
	assert.equal(firstChild.parentId, parent.id);
	assert.equal(firstChild.generation, 1);
	assert.notEqual(firstChild.id, secondChild.id);
	assert.equal(firstChild.workspaceId, "workspace-001");
	assert.equal(firstChild.hubPaneId, "pane-hub-001");
});

test("starting tasks can run and complete but terminal tasks cannot mutate", () => {
	const task = createParentTask({
		id: "turn-terminal",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});

	const running = transitionTask(task, "running");
	const completed = transitionTask(running, "completed");

	assert.equal(completed.state, "completed");
	assert.throws(() => transitionTask(completed, "running"), /terminal task/);
});

test("blocked, failed, cancelled, and orphaned generations are terminal", () => {
	const task = createParentTask({
		id: "turn-terminal-states",
		generation: 1,
		hubInstanceId: "hub-a",
		checkoutId: "checkout-a",
	});

	for (const state of ["completed", "blocked", "failed", "cancelled", "orphaned"] as const) {
		const terminal = transitionTask(task, state);
		assert.throws(() => transitionTask(terminal, "running"), /terminal task/, state);
	}

	const blocked = transitionTask(task, "blocked");
	assert.deepEqual(continueTask(blocked), { ...blocked, generation: 2, state: "starting" });
});
