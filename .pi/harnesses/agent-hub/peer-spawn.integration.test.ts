// Static schema/wiring contracts for index.ts. Executable launch behavior is
// covered by peer-spawn-plan.test.ts with a fake Herdr pane client.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const fleetToolsSource = readFileSync(new URL("./tools/fleet-tools.ts", import.meta.url), "utf8");
const herdrExecutorsSource = readFileSync(new URL("./tools/herdr-executors.ts", import.meta.url), "utf8");
const contextSource = readFileSync(new URL("./tools/context.ts", import.meta.url), "utf8");
const peerSpawnPlanSource = readFileSync(new URL("./peer-spawn-plan.ts", import.meta.url), "utf8");

test("wiring contract: Hub uses the shared same-project peer plan", () => {
	assert.match(herdrExecutorsSource, /import \{ buildHubPeerSpawnPlan, launchHubPeerInPane \} from "\.\.\/peer-spawn-plan\.ts"/);
	assert.match(herdrExecutorsSource, /buildHubPeerSpawnPlan\([\s\S]*?project: identity\.project[\s\S]*?personaExists:/);
	assert.doesNotMatch(herdrExecutorsSource, /peersYaml|envFile|parseEnvFile/);
	assert.match(herdrExecutorsSource, /launchHubPeerInPane\(plan, \{/);
	assert.match(herdrExecutorsSource, /waitForRegistration: name => waitForPeerRegistration\(/);
	assert.match(fleetToolsSource, /export async function waitForPeerRegistration\(/);
	assert.doesNotMatch(fleetToolsSource, /peerManifest/);
	assert.doesNotMatch(indexSource, /peerManifest/);
	assert.match(fleetToolsSource, /export function peerPersonaExists\(/);
	assert.match(fleetToolsSource, /export function spawnDelaySeconds\(/);
	assert.doesNotMatch(indexSource, /peerCommand\([\s\S]{0,800}"hub-spawned"/);
});

test("schema contract: herdr_spawn_peer takes the peer flags and excludes project, env, extensions, and raw command", () => {
	const registration = fleetToolsSource.match(/name:\s*"herdr_spawn_peer"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(registration, /runner:\s*Type\.Optional\(Type\.Union/);
	assert.match(registration, /persona:\s*Type\.Optional/);
	assert.match(registration, /no_persona:\s*Type\.Optional/);
	assert.match(registration, /model:\s*Type\.Optional/);
	assert.match(registration, /read_only:\s*Type\.Optional/);
	assert.match(registration, /direction:\s*Type\.Optional/);
	// Extension choice is gone (D17), and `.env` is a zero-access path (no env_file).
	for (const removed of ["extensions", "browser", "all_extensions", "env_file", "project", "command"]) {
		assert.doesNotMatch(registration, new RegExp(`\\b${removed}:\\s*Type\\.`), `${removed} must not be a herdr_spawn_peer parameter`);
	}
});

test("schema contract: raw pane spawn has no peer readiness semantics", () => {
	const registration = fleetToolsSource.match(/name:\s*"herdr_spawn_pane"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(registration, /name:\s*Type\.String/);
	assert.match(registration, /command:\s*Type\.String/);
	assert.doesNotMatch(registration, /persona:\s*Type\./);
	assert.doesNotMatch(registration, /waitForPeerRegistration|peer_ready\s*:|hubSpawnedPeers/);
	const execution = herdrExecutorsSource.match(/const executeHerdrSpawnPane[\s\S]*?(?=\n\tconst executeHerdrReadPane)/)?.[0] ?? "";
	assert.match(execution, /const argv = \["bash", "-lc", params\.command\]/);
	assert.match(execution, /launchPeerInPane\(d\.herdr, pane\.pane_id, argv\)/);
	assert.doesNotMatch(execution, /waitForPeerRegistration|peer_ready\s*:|hubSpawnedPeers/);
});

test("type contract: one herdr_spawn_peer shape, declared in the leaf tool-types module", () => {
	const declared = contextSource.match(/export interface HerdrSpawnPeerParams \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.deepEqual([...declared.matchAll(/^\t(\w+)\??:/gm)].map(match => match[1]), ["name", "runner", "persona", "no_persona", "model", "read_only", "direction"]);
	assert.match(peerSpawnPlanSource, /export type HubPeerSpawnRequest = HerdrSpawnPeerParams;/);
	// context.ts is imported by most Hub modules (and the damage-guard runtime closure);
	// importing the launcher adapter from it would drag the Fleet launch scripts along.
	assert.doesNotMatch(contextSource, /from "\.\.\/peer-spawn-plan\.ts"|agent-fleet\/scripts/);
});
