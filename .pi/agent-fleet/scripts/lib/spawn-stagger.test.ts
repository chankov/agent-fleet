// Tests for the pure stale-token detection that shields back-to-back pi pane
// spawns from the auth.json boot lock race (the delay itself is
// spawned-peers.js spawnStaggerSeconds).

import test from "node:test";
import assert from "node:assert/strict";

import { EXPIRY_MARGIN_MS, oauthNeedsWarmup, STAGGER_ENV_VAR, WARMUP_SECONDS } from "./spawn-stagger.ts";

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

test("the delay travels as AGENT_FLEET_SPAWN_DELAY with a positive warm-up", () => {
	assert.equal(STAGGER_ENV_VAR, "AGENT_FLEET_SPAWN_DELAY");
	assert.ok(WARMUP_SECONDS > 0);
});
