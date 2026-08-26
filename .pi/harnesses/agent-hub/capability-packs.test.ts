import assert from "node:assert/strict";
import test from "node:test";

import {
	CAPABILITY_PACKS,
	latestPersistedCapabilityState,
	persistedCapabilityState,
	resolveCapabilityPacks,
	type CapabilityResolutionInput,
} from "./capability-packs.ts";

const base = (overrides: Partial<CapabilityResolutionInput> = {}): CapabilityResolutionInput => ({
	workMode: "operator",
	userText: "hello",
	taskPacks: [],
	comsReady: false,
	herdrReady: false,
	pendingOperations: [],
	contextState: "normal",
	...overrides,
});

const surface = (input: Partial<CapabilityResolutionInput> = {}) => {
	const resolution = resolveCapabilityPacks(base(input));
	return { active: resolution.active, provisional: resolution.provisional, confirmationRequired: resolution.confirmationRequired };
};

const explicitIntentCases: Array<{
		name: string;
		input?: Partial<CapabilityResolutionInput>;
		active: string[];
		provisional?: string[];
	}> = [
		{ name: "greeting exposes core only", active: ["core"] },
		{ name: "operator direct work avoids fleet", input: { userText: "Fix the parser and run its tests." }, active: ["core"] },
		{ name: "orchestrator always has fleet", input: { workMode: "orchestrator" }, active: ["core", "fleet"] },
		{ name: "explicit delegation enables fleet", input: { userText: "Delegate this to a specialist." }, active: ["core", "fleet"] },
		{ name: "explicit research enables fleet", input: { userText: "Spawn a research helper for this." }, active: ["core", "fleet"] },
		{ name: "feature acceptance work enables verification", input: { userText: "Implement this feature.", taskTier: "feature" }, active: ["core", "verification"] },
		{ name: "explicit assertions enable verification", input: { userText: "Verify the acceptance criteria." }, active: ["core", "verification"] },
		{ name: "explicit ready coms enables peer", input: { userText: "Send this through coms to the existing peer.", comsReady: true }, active: ["core", "peer"] },
		{ name: "unready coms never enables peer", input: { userText: "Send this through coms to the existing peer.", comsReady: false }, active: ["core"] },
		{ name: "explicit ready pane enables workspace", input: { userText: "Open a Herdr pane for the watcher.", herdrReady: true }, active: ["core", "workspace"] },
		{ name: "unready Herdr never enables workspace", input: { userText: "Open a Herdr pane for the watcher.", herdrReady: false }, active: ["core"] },
		{ name: "explicit compaction enables compaction", input: { userText: "Please compact the conversation." }, active: ["core", "compaction"] },
		{ name: "approaching context exposes compaction", input: { contextState: "approaching-compaction" }, active: ["core", "compaction"] },
		{ name: "imminent context enables compaction", input: { contextState: "imminent-compaction" }, active: ["core", "compaction"] },
		{ name: "ordinary compact code wording does not enable compaction", input: { userText: "Make this compact." }, active: ["core"] },
		{ name: "mixed explicit intent enables each matching pack", input: { userText: "Delegate a specialist, message the peer on coms, and open a Herdr pane.", comsReady: true, herdrReady: true }, active: ["core", "fleet", "peer", "workspace"] },
	];

for (const row of explicitIntentCases) {
	test(`capability resolver: ${row.name}`, () => {
		const actual = surface(row.input);
		assert.deepEqual(actual.active, row.active);
		assert.deepEqual(actual.provisional, row.provisional ?? []);
		assert.deepEqual(actual.confirmationRequired, row.provisional ?? []);
	});
}

test("readiness is a prerequisite and never becomes intent", () => {
	assert.deepEqual(surface({ comsReady: true, herdrReady: true }), {
		active: ["core"], provisional: [], confirmationRequired: [],
	});
});

test("ambiguous execution gets only the smallest ready provisional pack", () => {
	assert.deepEqual(surface({ userText: "Could you get somebody else to handle this?" }), {
		active: ["core"], provisional: ["fleet"], confirmationRequired: ["fleet"],
	});
	assert.deepEqual(surface({ userText: "Can you contact them about this?", comsReady: true }), {
		active: ["core"], provisional: ["peer"], confirmationRequired: ["peer"],
	});
	assert.deepEqual(surface({ userText: "Can you start it somewhere?", herdrReady: true }), {
		active: ["core"], provisional: ["workspace"], confirmationRequired: ["workspace"],
	});
	assert.deepEqual(surface({ userText: "Can you contact them about this?", comsReady: false }), {
		active: ["core"], provisional: [], confirmationRequired: [],
	});
});

test("resolution is deterministic and reasons never retain user text", () => {
	const input = base({ userText: "Delegate a specialist and send a message through coms.", comsReady: true });
	const first = resolveCapabilityPacks(input);
	const second = resolveCapabilityPacks({ ...input, userText: `${input.userText}` });
	assert.deepEqual(first, second);
	assert.ok(Object.values(first.reasons).every(reason => !reason.includes("Delegate a specialist")));
	assert.equal(first.reasons.fleet, "explicit-fleet");
	assert.equal(first.reasons.peer, "explicit-peer");
});

test("provisional packs persist without silently becoming active", () => {
	const continued = resolveCapabilityPacks(base({
		userText: "continue direct work",
		provisionalPacks: ["fleet"],
	}));
	assert.deepEqual(continued.active, ["core"]);
	assert.deepEqual(continued.provisional, ["fleet"]);
	assert.deepEqual(continued.confirmationRequired, ["fleet"]);

	const reset = resolveCapabilityPacks(base({ provisionalPacks: ["fleet"], newTask: true }));
	assert.deepEqual(reset.provisional, []);
});

test("runtime compaction is transient and never becomes a retained task pack", () => {
	const approaching = resolveCapabilityPacks(base({
		taskPacks: ["fleet"],
		contextState: "approaching-compaction",
	}));
	assert.deepEqual(approaching.active, ["core", "fleet", "compaction"]);
	assert.deepEqual(approaching.nextTaskPacks, ["fleet"]);
	assert.equal(approaching.reasons.compaction, "approaching-compaction");

	const recovered = resolveCapabilityPacks(base({
		taskPacks: approaching.nextTaskPacks,
		contextState: "normal",
	}));
	assert.deepEqual(recovered.active, ["core", "fleet"]);
	assert.deepEqual(recovered.nextTaskPacks, ["fleet"]);
});

test("task packs are monotonic and pending operations lease active packs", () => {
	const continued = resolveCapabilityPacks(base({
		taskPacks: ["fleet", "verification"],
		userText: "Fix the parser.",
	}));
	assert.deepEqual(continued.active, ["core", "fleet", "verification"]);
	assert.deepEqual(continued.nextTaskPacks, ["fleet", "verification"]);
	assert.equal(continued.reasons.fleet, "task-retained");

	const leased = resolveCapabilityPacks(base({
		pendingOperations: [{ pack: "peer", kind: "message" }],
		comsReady: true,
	}));
	assert.deepEqual(leased.active, ["core", "peer"]);
	assert.deepEqual(leased.nextTaskPacks, ["peer"]);
	assert.equal(leased.reasons.peer, "pending-operation");
});

test("explicit new-task reset safely drops stale packs but preserves current work mode and pending leases", () => {
	const reset = resolveCapabilityPacks(base({
		workMode: "orchestrator",
		taskPacks: ["fleet", "verification", "peer", "workspace"],
		pendingOperations: [{ pack: "peer", kind: "message" }],
		comsReady: true,
		herdrReady: true,
		newTask: true,
	}));
	assert.deepEqual(reset.active, ["core", "fleet", "peer"]);
	assert.deepEqual(reset.nextTaskPacks, ["fleet", "peer"]);
	assert.equal(reset.reasons.fleet, "work-mode-required");
	assert.equal(reset.reasons.peer, "pending-operation");
});

test("persisted capability metadata is compact, restores only valid state, and excludes user text", () => {
	const resolution = resolveCapabilityPacks(base({ userText: "Delegate this exact secret request", taskTier: "feature" }));
	const persisted = persistedCapabilityState(resolution);
	assert.doesNotMatch(JSON.stringify(persisted), /secret request/);
	assert.deepEqual(latestPersistedCapabilityState([
		{ type: "custom", customType: "agent-hub-capability-packs", data: { taskPacks: ["bad"] } },
		{ type: "custom", customType: "agent-hub-capability-packs", data: persisted },
	]), persisted);
});

test("all output packs are known and peer/workspace are never active without readiness", () => {
	for (const workMode of ["operator", "orchestrator"] as const) {
		for (const comsReady of [false, true]) {
			for (const herdrReady of [false, true]) {
				const result = resolveCapabilityPacks(base({ workMode, comsReady, herdrReady, userText: "delegate, coms peer, Herdr pane" }));
				for (const pack of [...result.active, ...result.provisional]) {
					assert.ok(CAPABILITY_PACKS.includes(pack));
					if (pack === "peer") assert.equal(comsReady, true);
					if (pack === "workspace") assert.equal(herdrReady, true);
				}
			}
		}
	}
});
