import test from "node:test";
import assert from "node:assert/strict";

import { FakeHerdrServer } from "../../../scripts/lib/fake-herdr-server.ts";
import { MonitorStore } from "../../../scripts/lib/hermes-monitor-store.ts";
import { MonitorPublisher, createViewerGatedMonitor } from "./monitor-publisher.ts";

test("standard hub-team child records retain the fake workspace and hub-pane correlation", async () => {
	const fake = await FakeHerdrServer.start({ paneId: "hub-pane-monitor-smoke", workspaceId: "workspace-monitor-smoke" });
	try {
		const publisher = new MonitorPublisher(new MonitorStore());
		const parent = publisher.publishParent({ id: "turn-monitor-smoke", generation: 1, hubInstanceId: "hub", checkoutId: "checkout" });
		const child = await publisher.publishChildForHub(
			{ id: "child-monitor-smoke", generation: 1, parentId: parent.id, specialist: "builder" },
			{ HERDR_ENV: "1", HERDR_PANE_ID: "hub-pane-monitor-smoke", HERDR_SOCKET_PATH: fake.socketPath },
		);
		assert.equal(child.workspaceId, "workspace-monitor-smoke");
		assert.equal(child.hubPaneId, "hub-pane-monitor-smoke");
	} finally {
		await fake.close();
	}
});

test("viewer-gated polling runs once per second only while visible and fetches output only after its cursor advances", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const metadataCalls: number[] = [];
	const outputCalls: Array<{ afterSequence: number }> = [];
	let sequence = 1;
	const monitor = createViewerGatedMonitor({
		pollMetadata: async () => { metadataCalls.push(sequence); return [{ id: "task", generation: 1, outputSequence: sequence }]; },
		fetchOutput: async (_id, _generation, afterSequence) => { outputCalls.push({ afterSequence }); return { sequence }; },
	});
	try {
		t.mock.timers.tick(1000);
		await Promise.resolve();
		assert.deepEqual(metadataCalls, [], "zero viewers must schedule no metadata poll");
		assert.deepEqual(outputCalls, []);
		monitor.setViewers(1);
		t.mock.timers.tick(999);
		await Promise.resolve();
		assert.deepEqual(metadataCalls, []);
		t.mock.timers.tick(1);
		await Promise.resolve();
		assert.deepEqual(outputCalls, [{ afterSequence: 0 }]);
		t.mock.timers.tick(1000);
		await Promise.resolve();
		assert.deepEqual(outputCalls, [{ afterSequence: 0 }], "unchanged sequence must not fetch output again");
		sequence = 2;
		t.mock.timers.tick(1000);
		await Promise.resolve();
		assert.deepEqual(outputCalls, [{ afterSequence: 0 }, { afterSequence: 1 }]);
		monitor.setViewers(0);
		t.mock.timers.tick(5000);
		await Promise.resolve();
		assert.equal(metadataCalls.length, 3, "zero viewers must stop the interval");
	} finally {
		monitor.stop();
	}
});
