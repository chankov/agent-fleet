// Static schema/wiring contracts for index.ts. Executable launch behavior is
// covered by peer-spawn-plan.test.ts with a fake Herdr pane client.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const fleetToolsSource = readFileSync(new URL("./tools/fleet-tools.ts", import.meta.url), "utf8");

test("wiring contract: Hub uses the shared same-project peer plan", () => {
	assert.match(indexSource, /import \{ buildHubPeerSpawnPlan, launchHubPeerInPane \} from "\.\/peer-spawn-plan\.ts"/);
	assert.match(indexSource, /buildHubPeerSpawnPlan\([\s\S]*?project:\s*identity\.project[\s\S]*?peersYaml:[\s\S]*?personaExists:/);
	assert.match(indexSource, /launchHubPeerInPane\(plan,\s*\{/);
	assert.match(indexSource, /waitForRegistration:\s*\(name, timeoutMs\) => waitForPeerRegistration\(/);
	assert.match(fleetToolsSource, /export async function waitForPeerRegistration\(/);
	assert.match(fleetToolsSource, /export function peerManifest\(/);
	assert.match(fleetToolsSource, /export function peerPersonaExists\(/);
	assert.match(fleetToolsSource, /export function spawnDelaySeconds\(/);
	assert.doesNotMatch(indexSource, /peerCommand\([\s\S]{0,800}"hub-spawned"/);
});

test("schema contract: herdr_spawn_peer excludes project, env, and raw command", () => {
	const registration = fleetToolsSource.match(/name:\s*"herdr_spawn_peer"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(registration, /runner:\s*Type\.Optional\(Type\.Union/);
	assert.match(registration, /persona:\s*Type\.Optional/);
	assert.match(registration, /no_persona:\s*Type\.Optional/);
	assert.match(registration, /model:\s*Type\.Optional/);
	assert.match(registration, /extensions:\s*Type\.Optional/);
	assert.match(registration, /browser:\s*Type\.Optional/);
	assert.match(registration, /all_extensions:\s*Type\.Optional/);
	assert.doesNotMatch(registration, /project:\s*Type\./);
	assert.doesNotMatch(registration, /env_file:\s*Type\./);
	assert.doesNotMatch(registration, /command:\s*Type\./);
});

test("schema contract: raw pane spawn has no peer readiness semantics", () => {
	const registration = fleetToolsSource.match(/name:\s*"herdr_spawn_pane"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(registration, /name:\s*Type\.String/);
	assert.match(registration, /command:\s*Type\.String/);
	assert.doesNotMatch(registration, /persona:\s*Type\./);
	assert.doesNotMatch(registration, /waitForPeerRegistration|peer_ready\s*:|hubSpawnedPeers/);
	const execution = indexSource.match(/async function executeHerdrSpawnPane\([\s\S]*?(?=\n\tasync function executeHerdrReadPane)/)?.[0] ?? "";
	assert.match(execution, /const argv = \["bash", "-lc", params\.command\]/);
	assert.match(execution, /launchPeerInPane\(herdrApi, pane\.pane_id, argv\)/);
	assert.doesNotMatch(execution, /waitForPeerRegistration|peer_ready\s*:|hubSpawnedPeers/);
});
