import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionExecutors } from "./action-executors.ts";
import { PROFILE_ENV, setActiveProfile } from "../policy/profile-runtime.ts";

const allowProfile: any = {
	version: 2,
	defaults: { model: "omlx/laguna", thinking: "off" },
	fallback: "none",
	routing: "native",
	"allowed-models": ["omlx/laguna", "omlx/qwen"],
};

function withProfile(profile: any | undefined, name: string, run: () => Promise<void>) {
	const previous = process.env[PROFILE_ENV];
	setActiveProfile(profile ? { name, profile } : undefined);
	return run().finally(() => {
		if (previous === undefined) delete process.env[PROFILE_ENV];
		else process.env[PROFILE_ENV] = previous;
	});
}

function comsDeps(overrides: Record<string, unknown> = {}) {
	let sent = 0;
	return {
		sent: () => sent,
		budget: {},
		artifacts: {},
		hubState: { getPendingHandoff: () => null, setPendingHandoff() {} },
		provisionalCapabilityRefusal: () => null,
		getTaskTier: () => "feature",
		setTaskTier() {},
		getTaskTierAssumed: () => false,
		setTaskTierAssumed() {},
		getTaskDispatchCount: () => 0,
		getTaskResearchCount: () => 0,
		getTurnReport: () => ({}),
		getAssertions: () => [],
		setAssertions() {},
		getAgentStates: () => new Map(),
		rosterAdd: () => ({ ok: true, message: "ok" }),
		rosterDrop: () => ({ ok: true, message: "ok" }),
		getIdentity: () => ({}),
		getComs: () => ({
			send: async ({ target }: { target: string }) => {
				sent++;
				return { msg_id: "m1", target, target_session: "s1", hops: 0 };
			},
		}),
		resolveTarget: (target: string) => ({ name: target, model: "omlx/qwen" }),
		appendMachineHandoffSections: (brief: string) => brief,
		markPeerAddressed() {},
		...overrides,
	};
}

test("coms_send allows allowlisted peer model and refuses a foreign model without the blanket native text", async () => {
	await withProfile(allowProfile, "local-duo", async () => {
		const allowedDeps = comsDeps();
		const allowed = createActionExecutors(allowedDeps as any);
		const ok = await allowed.executeComsSend("1", { target: "test", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(ok.content[0].text, /coms_send → test/);
		assert.equal(allowedDeps.sent(), 1);

		const foreignDeps = comsDeps({ resolveTarget: () => ({ name: "claude", model: "anthropic/claude-opus-4-7" }) });
		const foreign = await createActionExecutors(foreignDeps as any).executeComsSend("1", { target: "claude", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(foreign.content[0].text, /refuses peer model "anthropic\/claude-opus-4-7"/);
		assert.doesNotMatch(foreign.content[0].text, /peer execution is disabled/);
		assert.equal(foreignDeps.sent(), 0);
		assert.equal((foreign as any).details.error, "model-profile-allowlist");
	});
});

test("coms_send without allowlist still uses the blanket native ban", async () => {
	const blanket: any = { version: 2, defaults: { model: "omlx/laguna", thinking: "off" }, fallback: "none", routing: "native" };
	await withProfile(blanket, "native-only", async () => {
		const deps = comsDeps();
		const result = await createActionExecutors(deps as any).executeComsSend("1", { target: "test", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(result.content[0].text, /peer execution is disabled/);
		assert.equal(deps.sent(), 0);
	});
});

test("coms_send with allowlist and missing target does not use the profile gate", async () => {
	await withProfile(allowProfile, "local-duo", async () => {
		let sendCalls = 0;
		const deps = comsDeps({
			resolveTarget: () => null,
			getComs: () => ({
				send: async () => {
					sendCalls++;
					throw new Error('Peer "ghost" not found in project "default". Live peers: (none)');
				},
			}),
		});
		await assert.rejects(
			() => createActionExecutors(deps as any).executeComsSend("1", { target: "ghost", prompt: "hi" } as any, new AbortController().signal, () => {}, {} as any),
			/not found/,
		);
		assert.equal(sendCalls, 1);
	});
});

test("handoff and herdr spawn call the allowlist-aware gate rather than a blanket native ban", () => {
	const root = dirname(fileURLToPath(import.meta.url));
	const hub = readFileSync(join(root, "../index.ts"), "utf8");
	assert.match(hub, /profilePeerGate\(\{ peerModel: peer\.model, targetResolved: true \}\)/);
	const herdr = readFileSync(join(root, "herdr-executors.ts"), "utf8");
	assert.match(herdr, /profileSpawnPeerRefusal\(plan\)/);
	assert.match(herdr, /env\[PROFILE_ENV\] = JSON\.stringify\(active\)/);
	assert.match(herdr, /profilePeerGate\(\{ targetResolved: false \}\)/);
});
