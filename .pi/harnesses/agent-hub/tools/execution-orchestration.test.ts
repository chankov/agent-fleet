import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preflightGate } from "./dispatch-execution.ts";

function dispatchDeps(overrides: Record<string, unknown> = {}): any {
	const blockers: Array<{ agent: string; what: string }> = [];
	let refused = false;
	return {
		state: {
			getExternalBlockers: () => blockers,
			getExternalBlockerAcknowledged: () => false,
			setExternalBlockerAcknowledged() {},
			getExternalBlockerRefusedOnce: () => refused,
			setExternalBlockerRefusedOnce: (value: boolean) => { refused = value; },
			isAskUserAvailable: () => true,
			getTaskTier: () => null,
		},
		...overrides,
	};
}

test("preflightGate preserves the external-blocker circuit breaker before persona policy", () => {
	const deps = dispatchDeps();
	deps.state.getExternalBlockers().push({ agent: "builder", what: "missing deployment credential" });
	const result = preflightGate(deps, "builder");
	assert.equal(result?.reason, "external_blocked");
	assert.match(result?.message ?? "", /missing deployment credential/);
	assert.equal(deps.state.getExternalBlockerRefusedOnce(), true);
});

test("orchestration routes all executor groups through explicit adapter ports", () => {
	const source = readFileSync(new URL("./execution-orchestration.ts", import.meta.url), "utf8");
	assert.match(source, /export interface DispatchExecutionContext/);
	assert.match(source, /dispatch: DispatchExecutorDeps/);
	assert.match(source, /actions: ActionExecutorDeps/);
	assert.match(source, /herdr: HerdrExecutorDeps/);
	assert.match(source, /createDispatchExecutor\(ctx\.dispatch\)/);
	assert.match(source, /\.\.\.createActionExecutors\(ctx\.actions\)/);
	assert.match(source, /\.\.\.createHerdrExecutors\(ctx\.herdr\)/);
});

test("writable-overlap counters have one composition owner and one executor mutation path", () => {
	const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const execution = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
	assert.equal((index.match(/let activeWritableDispatches/g) ?? []).length, 1);
	assert.equal((index.match(/let writableOverlapCounter/g) ?? []).length, 1);
	assert.equal((execution.match(/setActiveWritableDispatches/g) ?? []).length >= 2, true);
	assert.doesNotMatch(execution, /let activeWritableDispatches|let writableOverlapCounter/);
});
