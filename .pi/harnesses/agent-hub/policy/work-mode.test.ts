import assert from "node:assert/strict";
import test from "node:test";
import { createWorkModePolicy } from "./work-mode.ts";

function fixture(rosterSize = 1, fallbackRosterSize = 0) {
	let activeTools: string[] = []; const entries: [string, unknown][] = []; let replayed = 0; let fallbackAttempts = 0;
	const policy = createWorkModePolicy({
		getBaselineTools: () => ["read", "edit"], getRosterSize: () => rosterSize, getActiveTeamName: () => rosterSize ? "default" : "",
		activateFallbackRoster: () => { fallbackAttempts++; rosterSize = fallbackRosterSize; },
		getComsReady: () => false, getHerdrReady: () => false, getAskUserAvailable: () => true, getIdentityLabel: () => null,
		getTaskTier: () => "feature", getPendingOperations: () => [], getContextState: () => "normal",
		setActiveTools: tools => { activeTools = tools; }, persist: (type, data) => entries.push([type, data]),
		replayDeferredInputs: () => { replayed++; }, watchdogArmed: () => true,
	});
	const notices: [string, string][] = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notices.push([message, level]), setStatus: () => {}, select: async () => undefined } } as any;
	return { policy, ctx, notices, entries, tools: () => activeTools, replayed: () => replayed, fallbackAttempts: () => fallbackAttempts };
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

test("command and picker activate a fallback roster before switching to orchestrator", async () => {
	for (const picker of [false, true]) {
		const f = fixture(0, 2);
		if (picker) {
			f.ctx.ui.select = async (_title: string, options: string[]) => options[1];
			await f.policy.openPicker(f.ctx);
		} else await f.policy.applySelection("orchestrator", f.ctx);
		assert.equal(f.policy.getWorkMode(), "orchestrator");
		assert.equal(f.fallbackAttempts(), 1);
		assert.ok(f.tools().includes("dispatch_agent"));
		assert.ok(!f.tools().includes("edit"));
		assert.deepEqual(f.entries.at(-1), ["agent-hub-work-mode", { workMode: "orchestrator" }]);
		assert.match(f.notices.at(-1)![0], /Native roster: default \(2\)/);
	}
});

test("existing rosters, operator selection, and cancelled pickers never activate a fallback", async () => {
	const existing = fixture(1, 2);
	await existing.policy.applySelection("orchestrator", existing.ctx);
	assert.equal(existing.fallbackAttempts(), 0);
	const empty = fixture(0, 2);
	await empty.policy.openPicker(empty.ctx);
	await empty.policy.applySelection("operator", empty.ctx);
	assert.equal(empty.fallbackAttempts(), 0);
	assert.equal(empty.policy.getWorkMode(), "operator");
});

test("work-mode apply refuses orchestrator when no fallback roster is available", async () => {
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
