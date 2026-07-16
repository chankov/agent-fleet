import { test } from "node:test";
import assert from "node:assert/strict";

import { raceAskUser } from "./race-core.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function stockResult(label) {
	return {
		content: [{ type: "text", text: `User answered: ${label}` }],
		details: {
			question: "Ship it?",
			options: [],
			response: { kind: "freeform", text: label },
			cancelled: false,
		},
	};
}

test("local-first returns local result and emits one remote cancel when qid is pending", async () => {
	const local = deferred();
	const remote = deferred();
	const cancels = [];

	const raced = raceAskUser({
		runLocal: () => local.promise,
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async (qid, reason) => cancels.push({ qid, reason }),
	});

	const expected = stockResult("local");
	local.resolve(expected);
	assert.deepEqual(await raced, expected);
	assert.deepEqual(cancels, [{ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "local_answered" }]);

	remote.resolve(stockResult("remote-too-late"));
	await Promise.resolve();
	assert.equal(cancels.length, 1);
});

test("remote-first aborts the local signal and returns the remote stock-shaped result", async () => {
	const local = deferred();
	const remote = deferred();
	let localSignal;

	const raced = raceAskUser({
		runLocal: (signal) => {
			localSignal = signal;
			return local.promise;
		},
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async () => assert.fail("remote winner must not emit cancel"),
	});

	const expected = stockResult("remote");
	remote.resolve(expected);
	assert.deepEqual(await raced, expected);
	assert.equal(localSignal.aborted, true);

	local.resolve(stockResult("local-too-late"));
});

test("simultaneous local/remote resolution uses one latch and one winner", async () => {
	const local = deferred();
	const remote = deferred();
	let cancelCount = 0;
	let localSignal;

	const raced = raceAskUser({
		runLocal: (signal) => {
			localSignal = signal;
			return local.promise;
		},
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async () => { cancelCount += 1; },
	});

	const localResult = stockResult("local-same-tick");
	const remoteResult = stockResult("remote-same-tick");
	local.resolve(localResult);
	remote.resolve(remoteResult);

	const result = await raced;
	assert.ok(result === localResult || result === remoteResult);
	if (result === localResult) {
		assert.equal(cancelCount, 1);
		assert.equal(localSignal.aborted, false);
	} else {
		assert.equal(cancelCount, 0);
		assert.equal(localSignal.aborted, true);
	}
	await Promise.resolve();
	assert.ok(cancelCount === 0 || cancelCount === 1);
});

test("remote error falls back to local-only stock behavior", async () => {
	const local = deferred();
	const remote = deferred();
	let cancelCount = 0;
	let localSignal;

	const raced = raceAskUser({
		runLocal: (signal) => {
			localSignal = signal;
			return local.promise;
		},
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async () => { cancelCount += 1; },
	});

	remote.reject(new Error("remote unavailable"));
	await Promise.resolve();
	assert.equal(localSignal.aborted, false);

	const expected = stockResult("local-after-remote-error");
	local.resolve(expected);
	assert.deepEqual(await raced, expected);
	assert.equal(cancelCount, 0);
});

test("aborting the outer signal withdraws the remote question exactly once", async () => {
	const local = deferred();
	const remote = deferred();
	const cancels = [];
	const controller = new AbortController();

	const raced = raceAskUser({
		runLocal: () => local.promise,
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async (qid, reason) => cancels.push({ qid, reason }),
		signal: controller.signal,
	});

	controller.abort();
	local.resolve(stockResult("cancelled-locally"));
	await raced;
	await Promise.resolve();
	assert.deepEqual(cancels, [{ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "aborted" }]);
});

test("an already-aborted outer signal withdraws the remote question immediately", async () => {
	const local = deferred();
	const remote = deferred();
	const cancels = [];
	const controller = new AbortController();
	controller.abort();

	const raced = raceAskUser({
		runLocal: () => local.promise,
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async (qid, reason) => cancels.push({ qid, reason }),
		signal: controller.signal,
	});

	local.resolve(stockResult("local"));
	await raced;
	assert.deepEqual(cancels, [{ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "aborted" }]);
});

test("cancel emission is exactly once even when local wins and remote later settles", async () => {
	const local = deferred();
	const remote = deferred();
	let cancelCount = 0;

	const raced = raceAskUser({
		runLocal: () => local.promise,
		startRemote: () => ({ qid: "01ARZ3NDEKTSV4RRFFQ69G5FAV", result: remote.promise }),
		cancelRemote: async () => {
			cancelCount += 1;
			await Promise.resolve();
		},
	});

	local.resolve(stockResult("local"));
	await raced;
	remote.resolve(stockResult("remote"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(cancelCount, 1);
});
