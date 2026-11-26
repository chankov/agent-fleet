import assert from "node:assert/strict";
import test from "node:test";
import { createRosterPolicy } from "./roster.ts";

const defs = [{ name: "editor" }, { name: "reviewer" }];
function fixture(installed = defs) {
	const states = new Map<string, { def: { name: string }; status: string; sessionFile: string | null }>();
	let refreshes = 0; let recomputes = 0; let noticeResets = 0;
	const policy = createRosterPolicy({
		getDispatchableDefs: () => installed, getStates: () => states, clearBackendNotices: () => { noticeResets++; },
		createFreshState: (def, adoption) => ({ def, status: "idle", sessionFile: adoption?.file ?? null }),
		adoptSession: def => def.name === "reviewer" ? { file: null, quarantined: "/q/reviewer.json", reason: "truncated" } : { file: `/s/${def.name}.json`, quarantined: null, reason: null },
		recompute: () => { recomputes++; }, refreshUi: () => { refreshes++; }, displayName: name => name[0].toUpperCase() + name.slice(1),
	});
	return { policy, states, refreshes: () => refreshes, recomputes: () => recomputes, noticeResets: () => noticeResets };
}

test("populate puts every installed dispatchable role on the roster with adoptable state", () => {
	const f = fixture();
	f.states.set("stale", { def: { name: "stale" }, status: "idle", sessionFile: null });
	f.policy.populate();
	assert.deepEqual([...f.states.keys()], ["editor", "reviewer"]);
	assert.equal(f.states.get("editor")?.sessionFile, "/s/editor.json");
	assert.equal(f.noticeResets(), 1);
	assert.equal(f.recomputes(), 1);
});

test("add restores a missing installed role and refuses an uninstalled one", () => {
	const f = fixture();
	const added = f.policy.add("Reviewer");
	assert.equal(added.ok, true); assert.match(added.message, /quarantined.*starts clean/);
	assert.equal(f.policy.add("reviewer").ok, true, "an available role is not an error");
	const missing = f.policy.add("builder");
	assert.equal(missing.ok, false); assert.match(missing.message, /Installed: editor, reviewer/);
	assert.equal(f.refreshes(), 1);
});

test("addInstance adds a parallel instance once and keeps the existing state", () => {
	const f = fixture();
	f.policy.populate();
	const first = f.policy.addInstance({ name: "editor--p2" });
	assert.equal(first.ok, true); assert.match(first.message, /parallel instance/);
	const state = f.states.get("editor--p2");
	assert.equal(f.policy.addInstance({ name: "editor--p2" }).ok, true);
	assert.equal(f.states.get("editor--p2"), state);
	assert.deepEqual([...f.states.keys()], ["editor", "reviewer", "editor--p2"]);
});
