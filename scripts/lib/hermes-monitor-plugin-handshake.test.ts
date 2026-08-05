/**
 * The handshake Phase 4 depends on, end to end and across two languages.
 *
 * Everything between a launcher and the herdr panel is real here: the launcher
 * module picks the runtime directory, the Node registry writes the discovery
 * and token files, the real socket server answers on the real UDS, and a real
 * `python3` runs the herdr plugin's `tasks.py` — which finds the monitor's own
 * `adapter.py` through the sibling-plugin path, speaks the wire protocol, and
 * joins the result to a herdr pane id.
 *
 * Everything EXCEPT a live pi process, which contributes nothing to this chain
 * beyond calling `startChild`. The two links a unit test cannot fake are the
 * ones this covers: the 0700/0600 filesystem contract that both languages
 * enforce independently, and the `hubPaneId` join.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MonitorRegistry } from "../../.pi/harnesses/lib/hermes-monitor-registry.ts";
import { MonitorSocketServer } from "../../.pi/harnesses/lib/hermes-monitor-socket.ts";
import { MonitorStore } from "../../.pi/harnesses/lib/hermes-monitor-store.ts";
import { socketTempRoot, resolveMonitorEnv } from "./monitor-env.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const PANE = "wA:p1X";
const PROFILE = "handshake-test";

/** Run tasks.py the way the gateway would, and hand back what it answered.
 *
 *  Deliberately NOT `spawnSync`: the socket server this python process is about
 *  to call lives in THIS process's event loop, and a synchronous spawn blocks
 *  it — the request connects, nothing ever answers, and every assertion below
 *  fails as "the monitor is not answering". */
function askThePanel(runtimeDir: string, paneId: string): Promise<any> {
	const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(REPO, "hermes/plugins/agent-fleet-herdr/dashboard"))})
import tasks
print(json.dumps(tasks.tasks_for_pane(${JSON.stringify(paneId)}, env={
    "AGENT_FLEET_PROFILE_ID": ${JSON.stringify(PROFILE)},
    "AGENT_FLEET_MONITOR_RUNTIME_DIR": ${JSON.stringify(runtimeDir)},
})))
`;

	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", script]);
		let out = "";
		let err = "";
		child.stdout.on("data", chunk => { out += chunk; });
		child.stderr.on("data", chunk => { err += chunk; });
		child.on("error", reject);
		child.on("close", code => {
			if (code !== 0) return reject(new Error(`tasks.py exited ${code}: ${err}`));
			try {
				resolve(JSON.parse(out));
			} catch (error) {
				reject(new Error(`tasks.py printed ${JSON.stringify(out)}: ${error}`));
			}
		});
	});
}

test("a monitored hub is discovered, read and joined to its pane by the herdr plugin", async () => {
	// 1. The launcher decides where the runtime lives, and creates it 0700.
	const home = mkdtempSync(join(socketTempRoot(), "handshake-"));
	const env = resolveMonitorEnv({ XDG_RUNTIME_DIR: home, AGENT_FLEET_PROFILE_ID: PROFILE });
	assert.ok(env, "the launcher must produce a usable runtime directory");
	const runtimeDir = env.AGENT_FLEET_MONITOR_RUNTIME_DIR;

	// 2. The hub publishes a parent turn and one specialist, correlated to a
	//    herdr pane exactly as publishChildForHub does from HERDR_PANE_ID.
	const store = new MonitorStore();
	store.createParent({ id: "turn-1", generation: 1, hubInstanceId: "hub-1", checkoutId: "checkout-1" });
	store.createChild({
		id: "run-builder-1",
		generation: 1,
		parentId: "turn-1",
		parentGeneration: 1,
		specialist: "builder",
		workspaceId: "wA",
		hubPaneId: PANE,
	});
	store.appendPublicOutput("run-builder-1", 1, "npm test\n601 passing\n");

	// 3. The registry writes the discovery file and token; the socket listens.
	const registry = new MonitorRegistry({ runtimeDir, leaseMs: 30_000 });
	const registration = registry.register({
		profilePath: home,
		profileId: PROFILE,
		hubInstanceId: "hub-1",
		snapshot: () => store.snapshot(),
	});
	registration.output = (request: any) => store.readOutput(request.taskId, request.generation, request.afterSequence);
	const socket = new MonitorSocketServer(registration);
	await socket.listen();

	try {
		// 4. The panel asks, in Python, through the monitor plugin's adapter.
		const answer = await askThePanel(runtimeDir, PANE);

		assert.equal(answer.available, true, `panel said: ${answer.reason}`);
		assert.equal(answer.tasks.length, 1);
		const parent = answer.tasks[0];
		assert.equal(parent.id, "turn-1");
		assert.deepEqual(
			parent.children.map((c: any) => [c.specialist, c.state]),
			[["builder", "starting"]],
		);
		// The raw stdout the activity tail cannot carry.
		assert.match(parent.children[0].output, /601 passing/);

		// 5. The join is the pane, and a different pane owns nothing here.
		const elsewhere = await askThePanel(runtimeDir, "wZ:p9");
		assert.equal(elsewhere.available, true);
		assert.deepEqual(elsewhere.tasks, [], "another pane must not inherit this hub's subagents");

		// 6. The allowlist survives the round trip through two languages.
		for (const banned of ["ownerSessionId", "checkoutId", "workspaceId", "hubPaneId"]) {
			assert.ok(!(banned in parent.children[0]), `${banned} crossed the boundary`);
		}
	} finally {
		await socket.close();
		registration.cleanup();
	}
});

test("no hub registered under the profile is an absence, not an error", async () => {
	const home = mkdtempSync(join(socketTempRoot(), "handshake-empty-"));
	const env = resolveMonitorEnv({ XDG_RUNTIME_DIR: home, AGENT_FLEET_PROFILE_ID: PROFILE });
	assert.ok(env);

	// The ordinary case for anyone who has not opted in: the directory exists
	// because the launcher made it, and nothing has ever registered.
	const answer = await askThePanel(env.AGENT_FLEET_MONITOR_RUNTIME_DIR, PANE);
	assert.equal(answer.available, false);
	assert.deepEqual(answer.tasks, []);
	assert.match(answer.reason, /no monitored hub/);
});
