// Static schema/wiring contracts for index.ts. Executable launch behavior is
// covered by peer-spawn-plan.test.ts with a fake Herdr pane client.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("wiring contract: Hub uses the shared same-project peer plan", () => {
	assert.match(source, /import \{ buildHubPeerSpawnPlan, launchHubPeerInPane \} from "\.\/peer-spawn-plan\.ts"/);
	assert.match(source, /buildHubPeerSpawnPlan\([\s\S]*?project:\s*identity\.project[\s\S]*?peersYaml:[\s\S]*?personaExists:/);
	assert.match(source, /launchHubPeerInPane\(plan,\s*\{/);
	assert.doesNotMatch(source, /peerCommand\([\s\S]{0,800}"hub-spawned"/);
});

test("schema contract: herdr_spawn_peer excludes project, env, and raw command", () => {
	const registration = source.match(/name:\s*"herdr_spawn_peer"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
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
	const registration = source.match(/name:\s*"herdr_spawn_pane"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(registration, /name:\s*Type\.String/);
	assert.match(registration, /command:\s*Type\.String/);
	assert.doesNotMatch(registration, /persona:\s*Type\./);
	assert.doesNotMatch(registration, /waitForPeerRegistration|peer_ready\s*:|hubSpawnedPeers/);
	assert.match(source, /- \\`herdr_spawn_pane\\` starts a raw command pane/);
});
