import assert from "node:assert/strict";
import test from "node:test";
import { createRosterPolicy } from "./roster.ts";

const defs = [{ name: "builder" }, { name: "tester" }];
function fixture(mode: "operator" | "orchestrator" = "operator") {
	const states = new Map<string, { def: typeof defs[number]; status: string; sessionFile: string | null }>();
	let team = ""; const persisted: string[] = []; let refreshes = 0; let recomputes = 0;
	const policy = createRosterPolicy({
		getTeams: () => ({ default: ["builder"] }), getAllDefs: () => defs, getStates: () => states,
		getActiveTeamName: () => team, setActiveTeamName: value => { team = value; }, clearBackendNotices: () => {},
		createFreshState: (def, adoption) => ({ def, status: "idle", sessionFile: adoption?.file ?? null }),
		adoptSession: def => def.name === "tester" ? { file: null, quarantined: "/q/tester.json", reason: "truncated" } : { file: "/s/builder.json", quarantined: null, reason: null },
		quarantineSession: () => ({ usable: true, quarantined: null, reason: null }), persist: name => persisted.push(name),
		recompute: () => { recomputes++; }, refreshUi: () => { refreshes++; }, displayName: name => name[0].toUpperCase() + name.slice(1),
		orchestratorNeedsRosterAfterDrop: size => mode === "orchestrator" && size === 0,
	});
	return { policy, states, team: () => team, persisted, refreshes: () => refreshes, recomputes: () => recomputes };
}

test("roster activation and persistence preserve the named team and fresh adoptable state", () => {
	const f = fixture();
	f.policy.activateTeam("default");
	assert.equal(f.team(), "default");
	assert.equal(f.states.get("builder")?.sessionFile, "/s/builder.json");
	f.policy.persistActiveRoster();
	assert.deepEqual(f.persisted, ["default"]);
	assert.equal(f.recomputes(), 1);
});

test("dynamic roster reports quarantine recovery and protects the last orchestrator member", () => {
	const f = fixture("orchestrator");
	f.policy.activateTeam("default");
	const added = f.policy.add("tester");
	assert.equal(added.ok, true); assert.match(added.message, /quarantined.*starts clean/);
	assert.equal(f.policy.drop("tester").ok, true);
	const blocked = f.policy.drop("builder");
	assert.equal(blocked.ok, false); assert.match(blocked.message, /last team member/);
	assert.equal(f.refreshes(), 2);
});
