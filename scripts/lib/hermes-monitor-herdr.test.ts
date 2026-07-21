import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { correlateHubPane, watchHubMonitor } from "./hermes-monitor-herdr.ts";
import { FakeHerdrServer } from "./fake-herdr-server.ts";

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(message);
}

test("missing Herdr environment stays uncorrelated", async () => {
	assert.deepEqual(await correlateHubPane({}), { status: "uncorrelated" });
});

test("standard hub-team metadata resolves exact workspace and hub-pane IDs through the fake NDJSON server", async () => {
	const fake = await FakeHerdrServer.start({ paneId: "hub-pane-monitor-smoke", workspaceId: "workspace-monitor-smoke" });
	try {
		const correlation = await correlateHubPane({ HERDR_ENV: "1", HERDR_PANE_ID: "hub-pane-monitor-smoke", HERDR_SOCKET_PATH: fake.socketPath });
		assert.deepEqual(correlation, { workspaceId: "workspace-monitor-smoke", hubPaneId: "hub-pane-monitor-smoke", status: "correlated" });
		assert.equal(fake.requests[0]?.method, "pane.get");
	} finally {
		await fake.close();
	}
});

test("watchHubMonitor receives a fake status event, reconnects, and resynchronizes the changed workspace", async () => {
	const fake = await FakeHerdrServer.start({ paneId: "hub-pane", workspaceId: "workspace-before" });
	const statuses: Array<{ workspaceId?: string; hubPaneId?: string; status: string }> = [];
	const env = { HERDR_ENV: "1", HERDR_PANE_ID: "hub-pane", HERDR_SOCKET_PATH: fake.socketPath };
	const watch = watchHubMonitor({ env, reconnectDelayMs: 1, onStatus: (status) => statuses.push(status) });
	try {
		await eventually(() => fake.subscriptionCount() === 1 && statuses.some((status) => status.workspaceId === "workspace-before"), "initial fake subscription was not established");
		fake.setWorkspaceId("workspace-status-event");
		fake.emitStatus();
		await eventually(() => statuses.some((status) => status.workspaceId === "workspace-status-event"), "status event did not refresh workspace correlation");
		fake.setWorkspaceId("workspace-after-reconnect");
		fake.disconnectSubscribers();
		await eventually(() => fake.subscriptionCount() === 2 && statuses.some((status) => status.workspaceId === "workspace-after-reconnect"), "reconnect did not resubscribe and resynchronize state");
		assert.ok(statuses.some((status) => status.status === "reconnecting"));
	} finally {
		watch?.close();
		await fake.close();
	}
});

test("watchHubMonitor resynchronizes output cursors after reconnect without duplicate output replay", async () => {
	const api = await import("./hermes-monitor-herdr.ts") as typeof import("./hermes-monitor-herdr.ts") & { watchHubMonitor?: (options: unknown) => unknown };
	const received: Array<{ sequence: number; text: string }> = [];
	const fake = await FakeHerdrServer.start({ paneId: "hub-pane", workspaceId: "workspace", resyncOutput: { sequence: 8, text: "new output" } });
	let watch: { close?: () => void } | undefined;
	try {
		watch = api.watchHubMonitor?.({
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "hub-pane", HERDR_SOCKET_PATH: fake.socketPath },
			onStatus: () => {},
			onOutput: (output: { sequence: number; text: string }) => received.push(output),
			initialCursor: 7,
			reconnectDelayMs: 1,
		}) as { close?: () => void } | undefined;
		await eventually(() => fake.subscriptionCount() === 1, "fake subscription was not established");
		fake.disconnectSubscribers();
		await eventually(() => fake.subscriptionCount() === 2, "fake reconnect was not established");
		assert.deepEqual(received, [{ sequence: 8, text: "new output" }], "reconnect must replay only output newer than cursor 7 exactly once");
	} finally {
		watch?.close?.();
		await fake.close();
	}
});

test("monitor uses the existing Herdr client and never shells out", () => {
	const source = readFileSync(new URL("./hermes-monitor-herdr.ts", import.meta.url), "utf8");
	assert.match(source, /from "\.\.\/\.\.\/\.pi\/harnesses\/lib\/herdr-client\.ts"/);
	assert.doesNotMatch(source, /child_process|exec(?:File)?\(|spawn\(/);
});
