/**
 * The two variables that decide whether a hub is monitored at all.
 *
 * `monitorLifecycleConfig()` (.pi/harnesses/agent-hub/monitor-lifecycle.ts)
 * returns `null` unless BOTH `AGENT_FLEET_PROFILE_ID` and an absolute
 * `AGENT_FLEET_MONITOR_RUNTIME_DIR` are in the hub's environment. Until this
 * module existed the only thing that set them was a manual `export` copied out
 * of hermes/README.md, so in practice the monitor never started and its whole
 * transport — task tree, live output, per-generation cancel — was dead code
 * with a test suite.
 *
 * Two rules the rest of the file exists to hold:
 *
 *   1. An operator who already exported the variables wins. This never
 *      overwrites a value that is already set, so the README recipe and a
 *      systemd unit keep working exactly as documented.
 *   2. A runtime directory we cannot make private is not used. The Python
 *      reader refuses any root that is not mode 0700 (adapter.py), and it is
 *      right to: the directory holds one bearer token per live hub. Rather
 *      than hand it a path it will reject, `resolveMonitorEnv` returns null
 *      and the hub runs unmonitored — the pre-existing behaviour, reached
 *      honestly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Mirrors the profile-ID class in monitor-lifecycle.ts and adapter.py. All
 *  three must agree, because the runtime namespace is `sha256(profileId)` and a
 *  value one end accepts and another rejects is an empty directory listing with
 *  no error anywhere. */
export const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The Hermes profile the fleet plugins are installed in. `dev` rather than
 *  `default` by the 2026-07-27 decision recorded in the observability plan —
 *  the panel is a dev-profile tool, and the monitor has to land in the same
 *  profile or the discovery glob looks in the wrong namespace. */
export const DEFAULT_PROFILE_ID = "dev";

export const RUNTIME_DIR_NAME = "agent-fleet-monitor";
export const MAX_MONITOR_SOCKET_PATH_BYTES = 103;

const SOCKET_NAMESPACE_BYTES = 32;

function monitorSocketPathFits(runtimeDir: string): boolean {
	const longestSocketPath = path.join(runtimeDir, "s", "a".repeat(SOCKET_NAMESPACE_BYTES), "s");
	return Buffer.byteLength(longestSocketPath) <= MAX_MONITOR_SOCKET_PATH_BYTES;
}

export interface MonitorEnv {
	AGENT_FLEET_PROFILE_ID: string;
	AGENT_FLEET_MONITOR_RUNTIME_DIR: string;
}

/** Where the runtime root goes, before anything is created.
 *
 *  `XDG_RUNTIME_DIR` is the right answer and the one the README documents: it
 *  is already per-user, already 0700, and already cleaned up at logout. The
 *  tmpdir fallback exists for the sessions that have no such variable (a bare
 *  ssh login, a container), and carries the uid in its name so two users on one
 *  machine never race for the same path. */
export function monitorRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_RUNTIME_DIR;
	if (xdg && path.isAbsolute(xdg)) return path.join(xdg, RUNTIME_DIR_NAME);
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;

	return path.join(socketTempRoot(), `${RUNTIME_DIR_NAME}-${uid}`);
}

/** A temp root short enough to still hold a unix socket path underneath it.
 *
 *  macOS gives each process a long /var/folders/... temp path. Adding the
 *  monitor's 32-byte namespace to it exceeds sockaddr_un.sun_path (104 bytes,
 *  including its terminator), so libuv binds a truncated name that chmod cannot
 *  find. The child under /tmp is still created and verified mode 0700.
 *
 *  Exported because every test that binds a unix socket needs its fixture root
 *  built the same way — the monitor's, and ask-user-remote's per-question coms
 *  endpoints. Reaching for `os.tmpdir()` directly contradicts this rule and the
 *  failure does not look like a path-length problem from the test: the bind
 *  half-succeeds at a truncated name, so the chmod that follows throws ENOENT
 *  out of an already-listening handle and the process never exits. */
export function socketTempRoot(): string {
	return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

/** Create the runtime root 0700, or say why it cannot be trusted.
 *
 *  The mode is re-asserted on a directory that already exists because the
 *  `mode` argument to mkdir is a no-op for an existing path and is masked by
 *  umask for a new one — checking after the fact is the only way to know. A
 *  symlink is refused outright rather than followed: the whole point of the
 *  directory is that its contents are only reachable by this user, and a
 *  symlink means somebody else chose the destination. */
export function ensureMonitorRuntimeDir(dir: string, io: {
	mkdirSync?: typeof fs.mkdirSync;
	lstatSync?: typeof fs.lstatSync;
	chmodSync?: typeof fs.chmodSync;
} = {}): string | null {
	const mkdir = io.mkdirSync ?? fs.mkdirSync;
	const lstat = io.lstatSync ?? fs.lstatSync;
	const chmod = io.chmodSync ?? fs.chmodSync;
	if (!path.isAbsolute(dir)) return null;
	try {
		mkdir(dir, { recursive: true, mode: 0o700 });
		const stat = lstat(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
		if ((stat.mode & 0o777) !== 0o700) {
			chmod(dir, 0o700);
			if ((lstat(dir).mode & 0o777) !== 0o700) return null;
		}

		return dir;
	} catch {
		return null;
	}
}

/** The variables to add to a hub's environment, or null to leave it unmonitored.
 *
 *  Null is a normal outcome, not a failure: `AGENT_FLEET_MONITOR=0` is the
 *  documented opt-out, and an unusable runtime directory reaches the same
 *  result. Callers merge the answer and carry on either way — a hub that
 *  cannot be monitored still orchestrates. */
export function resolveMonitorEnv(
	env: NodeJS.ProcessEnv = process.env,
	ensure: (dir: string) => string | null = ensureMonitorRuntimeDir,
): MonitorEnv | null {
	if (env.AGENT_FLEET_MONITOR === "0") return null;

	const profileId = env.AGENT_FLEET_PROFILE_ID?.trim() || DEFAULT_PROFILE_ID;
	if (!PROFILE_ID_RE.test(profileId) || profileId.includes("..")) return null;

	const requested = env.AGENT_FLEET_MONITOR_RUNTIME_DIR?.trim();
	// An explicit path is honoured as given — including a rejection, which is
	// louder than silently relocating somebody's deliberate choice.
	const root = requested ? (path.isAbsolute(requested) ? requested : null) : monitorRuntimeRoot(env);
	if (!root) return null;
	if (!monitorSocketPathFits(root)) return null;

	const runtimeDir = ensure(root);
	if (!runtimeDir) return null;

	return { AGENT_FLEET_PROFILE_ID: profileId, AGENT_FLEET_MONITOR_RUNTIME_DIR: runtimeDir };
}
