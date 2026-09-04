import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_PROVIDER_LIMITS,
	createProviderSemaphore,
	parseProviderLimits,
	providerKey,
	providerLimit,
} from "./provider-semaphore.js";

const tick = () => new Promise((r) => setImmediate(r));
/** Let a chain of queued microtasks/immediates drain before asserting. */
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

test("providerKey takes the prefix before the first slash", () => {
	assert.equal(providerKey("custom/Qwen3.8-27B-Uncensored-MLX-4bit"), "custom");
	assert.equal(providerKey("openrouter/google/gemini-3-flash-preview"), "openrouter");
	assert.equal(providerKey(" OpenAI-Codex/gpt-5.6-luna "), "openai-codex");
	assert.equal(providerKey("bare-model"), "bare-model");
	assert.equal(providerKey(""), "");
	assert.equal(providerKey(undefined), "");
});

test("custom/* and omlx/* are limited by default", () => {
	assert.equal(providerLimit("omlx/Laguna-XS-2.1-4bit", DEFAULT_PROVIDER_LIMITS), 2);
	assert.equal(providerLimit("custom/Qwen3.8-27B-Uncensored-MLX-4bit", DEFAULT_PROVIDER_LIMITS), 2);
	assert.equal(providerLimit("openai-codex/gpt-5.6-luna", DEFAULT_PROVIDER_LIMITS), null);
	assert.equal(providerLimit("anthropic/claude-opus-4-7", DEFAULT_PROVIDER_LIMITS), null);
});

test("parseProviderLimits reads an override list and ignores junk", () => {
	assert.deepEqual(parseProviderLimits("custom=3,ollama=1"), { custom: 3, ollama: 1 });
	assert.deepEqual(parseProviderLimits(" CUSTOM = 4 "), { custom: 4 });
	assert.deepEqual(parseProviderLimits("custom=off"), { custom: null }); // off = unlimited
	assert.deepEqual(parseProviderLimits("custom=0"), { custom: null });
	assert.deepEqual(parseProviderLimits("garbage"), {});
	assert.deepEqual(parseProviderLimits(""), {});
	assert.deepEqual(parseProviderLimits(undefined), {});
});

test("an unlimited provider never queues", async () => {
	const sem = createProviderSemaphore();
	const releases = [];
	for (let i = 0; i < 10; i++) releases.push(await sem.acquire("openai-codex/gpt-5.6-luna"));
	assert.equal(sem.inFlight("openai-codex/x"), 10);
	assert.equal(sem.queued("openai-codex/x"), 0);
	for (const release of releases) release();
	assert.equal(sem.inFlight("openai-codex/x"), 0);
});

test("a limited provider admits up to the limit and queues the rest FIFO", async () => {
	const sem = createProviderSemaphore({ custom: 2 });
	const started = [];
	const done = [];
	const task = (name) =>
		sem.run("custom/Qwen", async () => {
			started.push(name);
			await tick();
			done.push(name);
		});
	const all = [task("a"), task("b"), task("c"), task("d")];

	// Only the limit runs immediately; the rest wait.
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(sem.inFlight("custom/Qwen"), 2);
	assert.equal(sem.queued("custom/Qwen"), 2);

	await Promise.all(all);
	// Queued work still completes, in the order it was requested.
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	assert.deepEqual(done, ["a", "b", "c", "d"]);
	assert.equal(sem.inFlight("custom/Qwen"), 0);
	assert.equal(sem.queued("custom/Qwen"), 0);
});

test("concurrency never exceeds the limit under load", async () => {
	const sem = createProviderSemaphore({ custom: 2 });
	let live = 0;
	let peak = 0;
	await Promise.all(
		Array.from({ length: 12 }, () =>
			sem.run("custom/Qwen", async () => {
				live++;
				peak = Math.max(peak, live);
				await settle(2);
				live--;
			}),
		),
	);
	assert.equal(peak, 2);
	assert.equal(sem.inFlight("custom/Qwen"), 0);
});

test("providers hold independent permits", async () => {
	const sem = createProviderSemaphore({ custom: 1, ollama: 1 });
	const a = await sem.acquire("custom/Qwen");
	const b = await sem.acquire("ollama/minimax-m3:cloud");
	assert.equal(sem.inFlight("custom/x"), 1);
	assert.equal(sem.inFlight("ollama/x"), 1);
	assert.equal(sem.queued("custom/x"), 0);
	a();
	b();
});

test("a failing task releases its permit", async () => {
	const sem = createProviderSemaphore({ custom: 1 });
	await assert.rejects(sem.run("custom/Qwen", async () => { throw new Error("boom"); }), /boom/);
	assert.equal(sem.inFlight("custom/Qwen"), 0);
	// The next caller is admitted immediately rather than waiting on a lost permit.
	const release = await sem.acquire("custom/Qwen");
	assert.equal(sem.inFlight("custom/Qwen"), 1);
	release();
});

test("releasing twice frees only one permit", async () => {
	const sem = createProviderSemaphore({ custom: 2 });
	const release = await sem.acquire("custom/Qwen");
	release();
	release();
	assert.equal(sem.inFlight("custom/Qwen"), 0);
	// Two more must still both fit, and a third must queue.
	await sem.acquire("custom/Qwen");
	await sem.acquire("custom/Qwen");
	let admitted = false;
	sem.acquire("custom/Qwen").then(() => { admitted = true; });
	await settle();
	assert.equal(admitted, false);
	assert.equal(sem.queued("custom/Qwen"), 1);
});

test("a nested spawn on the same provider cannot stall behind its own ancestor", async () => {
	// The permit is held by the leaf request. A parent that spawns a child on the
	// same provider passes its own permit down instead of taking a second one, so
	// a limit of 1 still completes a two-level tree.
	const sem = createProviderSemaphore({ custom: 1 });
	let inner = false;
	await sem.run("custom/Qwen", async (permit) => {
		await sem.run("custom/Qwen", async () => { inner = true; }, { parent: permit });
	});
	assert.equal(inner, true);
	assert.equal(sem.inFlight("custom/Qwen"), 0);
});
