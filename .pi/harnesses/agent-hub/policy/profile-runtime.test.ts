import assert from "node:assert/strict";
import test from "node:test";
import {
	PROFILE_ENV,
	modelAllowedByProfile,
	profileForcesNativePeers,
	profilePeerGate,
	profileSpawnPeerRefusal,
	setActiveProfile,
} from "./profile-runtime.ts";

const allowlist = ["omlx/laguna", "omlx/qwen"];
const allowProfile: any = {
	version: 2,
	defaults: { model: "omlx/laguna", thinking: "off" },
	fallback: "none",
	routing: "native",
	"allowed-models": allowlist,
};
const blanketProfile: any = {
	version: 2,
	defaults: { model: "omlx/laguna", thinking: "off" },
	fallback: "none",
	routing: "native",
};

function withProfile(profile: any | undefined, name: string, run: () => void) {
	const previous = process.env[PROFILE_ENV];
	try {
		setActiveProfile(profile ? { name, profile } : undefined);
		run();
	} finally {
		if (previous === undefined) delete process.env[PROFILE_ENV];
		else process.env[PROFILE_ENV] = previous;
	}
}

test("modelAllowedByProfile: exact hit, unique suffix, foreign, unknown, ambiguous suffix", () => {
	assert.equal(modelAllowedByProfile("omlx/qwen", allowlist), true);
	assert.equal(modelAllowedByProfile("qwen", allowlist), true);
	assert.equal(modelAllowedByProfile("anthropic/claude-opus-4-7", allowlist), false);
	assert.equal(modelAllowedByProfile("unknown", allowlist), false);
	assert.equal(modelAllowedByProfile("", allowlist), false);
	assert.equal(modelAllowedByProfile("qwen", ["omlx/qwen", "cloud/qwen"]), false);
});

test("profilePeerGate: exact allowlist hit, unique suffix, foreign model, unknown, native without allowlist = full ban", () => {
	withProfile(allowProfile, "local-duo", () => {
		assert.equal(profilePeerGate({ peerModel: "omlx/qwen", targetResolved: true }), null);
		assert.equal(profilePeerGate({ peerModel: "qwen", targetResolved: true }), null);
		const foreign = profilePeerGate({ peerModel: "anthropic/claude-opus-4-7", targetResolved: true });
		assert.equal(foreign?.details.error, "model-profile-allowlist");
		assert.match(foreign!.content[0].text, /refuses peer model "anthropic\/claude-opus-4-7"/);
		assert.doesNotMatch(foreign!.content[0].text, /peer execution is disabled/);
		const unknown = profilePeerGate({ peerModel: "unknown", targetResolved: true });
		assert.equal(unknown?.details.error, "model-profile-allowlist");
		assert.match(unknown!.content[0].text, /missing or unknown/);
		assert.equal(profilePeerGate({ targetResolved: false }), null);
		assert.equal(profileForcesNativePeers(), false);
	});
	withProfile(blanketProfile, "native-only", () => {
		assert.equal(profileForcesNativePeers(), true);
		const ban = profilePeerGate({ peerModel: "omlx/qwen", targetResolved: true });
		assert.equal(ban?.details.error, "model-profile-native");
		assert.match(ban!.content[0].text, /peer execution is disabled/);
		assert.equal(profilePeerGate({ targetResolved: false })?.details.error, "model-profile-native");
	});
	withProfile(undefined, "none", () => {
		assert.equal(profilePeerGate({ peerModel: "cloud/sol", targetResolved: true }), null);
		assert.equal(profileForcesNativePeers(), false);
	});
});

test("profileSpawnPeerRefusal: allowed pi model passes; foreign model and claude-code refuse", () => {
	withProfile(allowProfile, "local-duo", () => {
		assert.equal(profileSpawnPeerRefusal({ runner: "pi", name: "test", model: "omlx/qwen" }), null);
		assert.equal(profileSpawnPeerRefusal({ runner: "pi", name: "documenter" }), null);
		const foreign = profileSpawnPeerRefusal({ runner: "pi", name: "test", model: "openai-codex/gpt-5.6-sol" });
		assert.equal(foreign?.details.error, "model-profile-allowlist");
		const claude = profileSpawnPeerRefusal({ runner: "claude-code", name: "code-reviewer", model: "opus" });
		assert.equal(claude?.details.error, "model-profile-allowlist");
		assert.match(claude!.content[0].text, /refuses claude-code peers/);
	});
	withProfile(blanketProfile, "native-only", () => {
		assert.equal(profileSpawnPeerRefusal({ runner: "pi", name: "test", model: "omlx/qwen" })?.details.error, "model-profile-native");
	});
});
