import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_PROFILE_ID,
	ensureMonitorRuntimeDir,
	monitorRuntimeRoot,
	resolveMonitorEnv,
} from "./monitor-env.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "monitor-env-"));

test("an operator's own export always wins over the defaults", () => {
	const runtime = path.join(tmp(), "chosen");
	const value = resolveMonitorEnv({ AGENT_FLEET_PROFILE_ID: "prod-2", AGENT_FLEET_MONITOR_RUNTIME_DIR: runtime });
	assert.deepEqual(value, { AGENT_FLEET_PROFILE_ID: "prod-2", AGENT_FLEET_MONITOR_RUNTIME_DIR: runtime });
	assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
});

test("nothing set at all lands on the dev profile under XDG_RUNTIME_DIR", () => {
	const xdg = tmp();
	const value = resolveMonitorEnv({ XDG_RUNTIME_DIR: xdg });
	assert.equal(value?.AGENT_FLEET_PROFILE_ID, DEFAULT_PROFILE_ID);
	assert.equal(value?.AGENT_FLEET_MONITOR_RUNTIME_DIR, path.join(xdg, "agent-fleet-monitor"));
});

test("no XDG_RUNTIME_DIR falls back to a uid-scoped tmpdir rather than a shared one", () => {
	const root = monitorRuntimeRoot({});
	assert.ok(root.startsWith(os.tmpdir()));
	// Two users on one machine must not resolve to the same path.
	assert.ok(root.endsWith(`-${typeof process.getuid === "function" ? process.getuid() : 0}`));
});

test("AGENT_FLEET_MONITOR=0 is the opt-out and leaves the hub unmonitored", () => {
	assert.equal(resolveMonitorEnv({ AGENT_FLEET_MONITOR: "0", XDG_RUNTIME_DIR: tmp() }), null);
});

test("a profile id the Python reader would reject is refused here, not passed on", () => {
	// adapter.canonical_profile_id hashes the id; a value it rejects produces an
	// empty discovery glob and no error anywhere, which is the worst outcome.
	for (const bad of ["../escape", ".hidden", "has/slash", "a".repeat(129)]) {
		assert.equal(resolveMonitorEnv({ AGENT_FLEET_PROFILE_ID: bad, XDG_RUNTIME_DIR: tmp() }), null, `accepted ${JSON.stringify(bad)}`);
	}
	// An empty or blank value is "unset", not "invalid": a shell that exports
	// AGENT_FLEET_PROFILE_ID= meant to say nothing, and falling back is kinder
	// than refusing to monitor over a stray equals sign.
	assert.equal(resolveMonitorEnv({ AGENT_FLEET_PROFILE_ID: "  ", XDG_RUNTIME_DIR: tmp() })?.AGENT_FLEET_PROFILE_ID, DEFAULT_PROFILE_ID);
});

test("a relative runtime dir is refused rather than resolved against some cwd", () => {
	assert.equal(resolveMonitorEnv({ AGENT_FLEET_MONITOR_RUNTIME_DIR: "runtime/monitor" }), null);
});

test("a runtime dir that cannot be made 0700 leaves the hub unmonitored", () => {
	const root = tmp();
	const dir = path.join(root, "loose");
	fs.mkdirSync(dir, { mode: 0o755 });
	fs.chmodSync(dir, 0o755);
	// ensureMonitorRuntimeDir repairs the mode; a repair that does not stick is
	// the case that must fail closed, because adapter.py refuses the root and
	// the panel would show "no monitor" with nothing explaining why.
	assert.equal(ensureMonitorRuntimeDir(dir), dir);
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

	const stubborn = path.join(root, "stubborn");
	fs.mkdirSync(stubborn, { mode: 0o755 });
	assert.equal(
		ensureMonitorRuntimeDir(stubborn, { chmodSync: () => {}, lstatSync: (p: fs.PathLike) => ({ ...fs.lstatSync(p), mode: 0o40755, isSymbolicLink: () => false, isDirectory: () => true }) as fs.Stats }),
		null,
	);
});

test("a symlinked runtime root is refused — somebody else chose the destination", () => {
	const root = tmp();
	const real = path.join(root, "real");
	const link = path.join(root, "link");
	fs.mkdirSync(real, { mode: 0o700 });
	fs.symlinkSync(real, link);
	assert.equal(ensureMonitorRuntimeDir(link), null);
	assert.equal(resolveMonitorEnv({ AGENT_FLEET_MONITOR_RUNTIME_DIR: link }), null);
});
