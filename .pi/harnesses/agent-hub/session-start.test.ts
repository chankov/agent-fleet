import assert from "node:assert/strict";
import test from "node:test";

import {
	registerSessionStart,
	runSessionStart,
	SESSION_START_STEP_ORDER,
	type SessionStartDependencies,
} from "./session-start.ts";

function dependencies(calls: string[]): SessionStartDependencies {
	return Object.fromEntries(SESSION_START_STEP_ORDER.map(name => [name, async () => { calls.push(name); }])) as SessionStartDependencies;
}

test("session-start facade preserves the exact side-effect order", async () => {
	const calls: string[] = [];
	await runSessionStart({} as never, dependencies(calls));
	assert.deepEqual(calls, SESSION_START_STEP_ORDER);
});

test("session-start registration rejects every missing injected helper", () => {
	for (const missing of SESSION_START_STEP_ORDER) {
		const deps = dependencies([]) as unknown as Record<string, unknown>;
		delete deps[missing];
		assert.throws(
			() => registerSessionStart({ on() {} } as never, deps as SessionStartDependencies),
			new RegExp(`session_start dependency "${missing}" must be a function`),
		);
	}
});

test("registered session_start delegates to the typed runner", async () => {
	let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	const calls: string[] = [];
	registerSessionStart({ on(name: string, callback: typeof handler) {
		assert.equal(name, "session_start");
		handler = callback;
	} } as never, dependencies(calls));
	assert.ok(handler);
	await handler({}, {});
	assert.deepEqual(calls, SESSION_START_STEP_ORDER);
});
