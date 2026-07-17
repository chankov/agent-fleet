// Tests for the pure pre-warm/stagger logic that shields simultaneous pi
// pane spawns from the auth.json boot lock race.

import test from "node:test";
import assert from "node:assert/strict";

import { EXPIRY_MARGIN_MS, oauthNeedsWarmup, STEP_SECONDS, staggerDelays, WARMUP_SECONDS } from "./spawn-stagger.ts";

const NOW = 1_800_000_000_000;

function authJson(entries: Record<string, unknown>): string {
	return JSON.stringify(entries);
}

test("missing or unreadable auth.json never staggers", () => {
	assert.equal(oauthNeedsWarmup(undefined, NOW), false);
	assert.equal(oauthNeedsWarmup("", NOW), false);
});

test("malformed auth.json never staggers", () => {
	assert.equal(oauthNeedsWarmup("not json{", NOW), false);
	assert.equal(oauthNeedsWarmup('"a string"', NOW), false);
	assert.equal(oauthNeedsWarmup(authJson({ codex: "nope" }), NOW), false);
});

test("fresh oauth tokens do not stagger", () => {
	const raw = authJson({
		"openai-codex": { type: "oauth", expires: NOW + 10 * 60_000 },
		"github-copilot": { type: "oauth", expires: NOW + 2 * 60 * 60_000 },
	});
	assert.equal(oauthNeedsWarmup(raw, NOW), false);
});

test("an expired oauth token staggers", () => {
	const raw = authJson({
		"openai-codex": { type: "oauth", expires: NOW - 1 },
		"github-copilot": { type: "oauth", expires: NOW + 2 * 60 * 60_000 },
	});
	assert.equal(oauthNeedsWarmup(raw, NOW), true);
});

test("a token expiring inside the margin counts as stale", () => {
	const raw = authJson({ "openai-codex": { type: "oauth", expires: NOW + EXPIRY_MARGIN_MS - 1 } });
	assert.equal(oauthNeedsWarmup(raw, NOW), true);
});

test("api_key credentials never stagger — no refresh, no long lock hold", () => {
	const raw = authJson({ anthropic: { type: "api_key", key: "sk-test" } });
	assert.equal(oauthNeedsWarmup(raw, NOW), false);
});

test("not needed → all-zero delays regardless of shape", () => {
	assert.deepEqual(staggerDelays({ peerIsPi: [true, true, true], rootIsPi: true, needed: false }), [0, 0, 0]);
	assert.deepEqual(staggerDelays({ peerIsPi: [true, false], rootIsPi: false, needed: false }), [0, 0]);
});

test("hub mode: hub warms, every pi peer waits", () => {
	const delays = staggerDelays({ peerIsPi: [true, true, true], rootIsPi: true, needed: true });
	assert.deepEqual(delays, [WARMUP_SECONDS, WARMUP_SECONDS + STEP_SECONDS, WARMUP_SECONDS + 2 * STEP_SECONDS]);
});

test("peers mode: first pi peer warms at 0, the rest wait", () => {
	const delays = staggerDelays({ peerIsPi: [true, true, true], rootIsPi: false, needed: true });
	assert.deepEqual(delays, [0, WARMUP_SECONDS, WARMUP_SECONDS + STEP_SECONDS]);
});

test("claude-code panes never wait and never count as the warmer", () => {
	const delays = staggerDelays({ peerIsPi: [false, true, true], rootIsPi: false, needed: true });
	assert.deepEqual(delays, [0, 0, WARMUP_SECONDS]);
});

test("conductor mode (non-pi root) behaves like peers mode", () => {
	const delays = staggerDelays({ peerIsPi: [true, true], rootIsPi: false, needed: true });
	assert.deepEqual(delays, [0, WARMUP_SECONDS]);
});
