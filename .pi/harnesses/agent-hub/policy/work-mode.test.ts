import assert from "node:assert/strict";
import test from "node:test";
import { createWorkModePolicy } from "./work-mode.ts";

function fixture(rosterSize = 1) {
	let activeTools: string[] = []; const entries: [string, unknown][] = []; let replayed = 0;
	const policy = createWorkModePolicy({
		getBaselineTools: () => ["read", "edit"], getRosterSize: () => rosterSize, getActiveTeamName: () => rosterSize ? "default" : "",
		getComsReady: () => false, getHerdrReady: () => false, getAskUserAvailable: () => true, getIdentityLabel: () => null,
		getTaskTier: () => "feature", getPendingOperations: () => [], getContextState: () => "normal",
		setActiveTools: tools => { activeTools = tools; }, persist: (type, data) => entries.push([type, data]),
		replayDeferredInputs: () => { replayed++; }, watchdogArmed: () => true,
	});
	const notices: [string, string][] = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notices.push([message, level]), setStatus: () => {}, select: async () => undefined } } as any;
	return { policy, ctx, notices, entries, tools: () => activeTools, replayed: () => replayed };
}

test("validated work-mode commit persists, recomputes capabilities, and applies active tools", async () => {
	const f = fixture();
	assert.equal(await f.policy.commit("orchestrator", f.ctx), "ok");
	assert.equal(f.policy.getWorkMode(), "orchestrator");
	assert.ok(f.policy.getCapabilityResolution().active.includes("fleet"));
	assert.ok(f.tools().includes("dispatch_agent"));
	assert.deepEqual(f.entries.at(-1), ["agent-hub-work-mode", { workMode: "orchestrator" }]);
	assert.equal(await f.policy.commit("orchestrator", f.ctx), "unchanged");
	assert.equal(await f.policy.commit("operator", f.ctx), "ok");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(f.replayed(), 1);
});

test("work-mode apply and picker contracts refuse orchestrator without a roster", async () => {
	const f = fixture(0);
	await f.policy.applySelection("orchestrator", f.ctx);
	assert.equal(f.policy.getWorkMode(), "operator");
	assert.match(f.notices[0][0], /requires at least one native specialist/);
	assert.equal(f.entries.some(([type]) => type === "agent-hub-work-mode"), false);
});

test("capability confirmation promotes provisional packs and operation leases keep packs active", () => {
	const f = fixture();
	f.policy.resolveIncomingCapabilities("someone else to handle this");
	assert.ok(f.policy.getCapabilityResolution().provisional.includes("fleet"));
	assert.equal(f.policy.provisionalCapabilityRefusal("fleet")?.details.status, "provisional_confirmation_required");
	f.policy.setCapabilityConfirmation("fleet", "promoted");
	f.policy.resolveIncomingCapabilities("");
	assert.ok(f.policy.getCapabilityResolution().active.includes("fleet"));
	assert.equal(f.policy.provisionalCapabilityRefusal("fleet"), null);
});
