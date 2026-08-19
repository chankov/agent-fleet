import assert from "node:assert/strict";
import test from "node:test";

import { resolveCapabilityPacks, type CapabilityResolutionInput } from "./capability-packs.ts";
import { COMS_TOOLS, FLEET_TOOLS, HERDR_TOOLS, resolvePostureTools, VERIFICATION_TOOLS } from "./posture.ts";
import { confirmationGate, type CapabilityConfirmationState } from "./capability-confirmation.ts";

const baseline = ["read", "bash", "edit", "write"];
const base = (overrides: Partial<CapabilityResolutionInput> = {}): CapabilityResolutionInput => ({
	posture: "operator", userText: "hello", taskPacks: [], comsReady: false, herdrReady: false,
	pendingOperations: [], contextState: "normal", ...overrides,
});

function surface(input: Partial<CapabilityResolutionInput> = {}) {
	const resolution = resolveCapabilityPacks(base(input));
	const tools = resolvePostureTools({
		posture: input.posture ?? "operator", baselineTools: baseline,
		comsReady: input.comsReady ?? false, herdrReady: input.herdrReady ?? false,
		askUserAvailable: true, capabilityPacks: [...resolution.active, ...resolution.provisional],
	});
	return { resolution, tools };
}

const absent = (tools: readonly string[], names: readonly string[]) => names.every(name => !tools.includes(name));

test("end-to-end deterministic capability matrix exposes only the intended profile surfaces", () => {
	const greeting = surface();
	assert.deepEqual(greeting.resolution.active, ["core"]);
	assert.ok(baseline.every(tool => greeting.tools.includes(tool)));
	assert.ok(absent(greeting.tools, [...FLEET_TOOLS, ...VERIFICATION_TOOLS, ...COMS_TOOLS, ...HERDR_TOOLS, "request_compaction"]));

	const direct = surface({ userText: "Fix the parser and run its tests." });
	assert.deepEqual(direct.resolution.active, ["core"]);
	assert.ok(absent(direct.tools, [...FLEET_TOOLS, ...VERIFICATION_TOOLS]));

	const fleet = surface({ userText: "Delegate this implementation to a specialist." });
	assert.ok(FLEET_TOOLS.every(tool => fleet.tools.includes(tool)));
	assert.ok(absent(fleet.tools, [...VERIFICATION_TOOLS, ...COMS_TOOLS, ...HERDR_TOOLS]));

	const orchestrator = surface({ posture: "orchestrator" });
	assert.ok(FLEET_TOOLS.every(tool => orchestrator.tools.includes(tool)));
	assert.ok(absent(orchestrator.tools, baseline));

	const verification = surface({ userText: "Implement this feature with acceptance criteria.", taskTier: "feature" });
	assert.ok(VERIFICATION_TOOLS.every(tool => verification.tools.includes(tool)));
	assert.ok(absent(verification.tools, [...FLEET_TOOLS, ...COMS_TOOLS, ...HERDR_TOOLS]));

	const peer = surface({ userText: "Send this through coms to the existing peer.", comsReady: true });
	assert.ok(COMS_TOOLS.every(tool => peer.tools.includes(tool)));
	assert.ok(absent(peer.tools, [...FLEET_TOOLS, ...HERDR_TOOLS]));

	const workspace = surface({ userText: "Open a Herdr pane for the watcher.", herdrReady: true });
	assert.ok(HERDR_TOOLS.every(tool => workspace.tools.includes(tool)));
	assert.ok(absent(workspace.tools, [...FLEET_TOOLS, ...COMS_TOOLS]));

	const compaction = surface({ userText: "Please compact the conversation." });
	assert.ok(compaction.tools.includes("request_compaction"));
	assert.ok(absent(compaction.tools, [...FLEET_TOOLS, ...VERIFICATION_TOOLS, ...COMS_TOOLS, ...HERDR_TOOLS]));

	const approaching = surface({ contextState: "approaching-compaction" });
	assert.ok(approaching.tools.includes("request_compaction"));
	assert.deepEqual(approaching.resolution.nextTaskPacks, []);
});

test("provisional packs cannot bypass server-side confirmation and explicit new-task resets stale state", () => {
	for (const [pack, input] of [
		["fleet", { userText: "Could you get somebody else to handle this?" }],
		["peer", { userText: "Can you contact them about this?", comsReady: true }],
		["workspace", { userText: "Can you start it somewhere?", herdrReady: true }],
	] as const) {
		const { resolution, tools } = surface(input);
		assert.deepEqual(resolution.provisional, [pack]);
		assert.ok(tools.length > 0, `${pack} is visible so its confirmation is explainable`);
		const state: CapabilityConfirmationState = {};
		assert.equal(confirmationGate(state, pack, true).allowed, false, `${pack} side effect is refused before confirmation`);
		state[pack] = "promoted";
		assert.equal(confirmationGate(state, pack, true).allowed, true, `${pack} is allowed only after confirmation`);
		state[pack] = "declined";
		assert.equal(confirmationGate(state, pack, true).allowed, false, `${pack} remains blocked after rejection`);
	}
	const reset = surface({ taskPacks: ["fleet", "verification", "peer"], newTask: true });
	assert.deepEqual(reset.resolution.active, ["core"]);
	assert.deepEqual(reset.resolution.provisional, []);
});
