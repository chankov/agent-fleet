import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { confineNativeChild, linuxUserNamespaceSandboxAvailable, policyFor } from "./write-isolation.ts";
import { assertSafeSandboxStdio, killPiTree, spawnPiAgent } from "./spawn.ts";

const hasLinuxSandbox = linuxUserNamespaceSandboxAvailable();

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-t6c-"));
	mkdirSync(join(root, "allowed-dir"));
	mkdirSync(join(root, "blocked-dir"));
	mkdirSync(join(root, "runtime"));
	mkdirSync(join(root, "artifacts"));
	mkdirSync(join(root, "temp"));
	writeFileSync(join(root, "allowed.txt"), "before");
	writeFileSync(join(root, "blocked.txt"), "user-before");
	return root;
}

function shellLaunch(root: string, script: string, extra: Record<string, unknown> = {}) {
	return confineNativeChild({
		enabled: true,
		cwd: root,
		allowlist: ["allowed.txt", "allowed-dir/"],
		runtimePaths: [join(root, "runtime")],
		artifactPaths: [join(root, "artifacts")],
		tempPaths: [join(root, "temp")],
		command: "/bin/sh",
		args: ["-c", script],
		...extra,
	});
}

function runLaunch(launch: ReturnType<typeof shellLaunch>) {
	assert.equal(launch.applied, true, launch.reason);
	const result = spawnSync(launch.command!, launch.args!, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, encoding: "utf8", timeout: 10_000 });
	return result;
}

test("T6c opt-out leaves the original command and permissions unchanged", () => {
	const off = confineNativeChild({ enabled: false, command: "pi", args: ["--version"], allowlist: ["docs/**"] });
	assert.equal(off.applied, false);
	assert.equal(off.failClosed, false);
	assert.equal(off.permissionExpansion, false);
	assert.equal(off.command, "pi");
	assert.deepEqual(off.args, ["--version"]);
});

test("T6c rejects globs, escaping paths, missing and mismatched backends without fallback", () => {
	const root = fixture();
	for (const allowlist of [["docs/**"], ["../escape"]]) {
		const refused = confineNativeChild({ enabled: true, cwd: root, backend: process.platform === "darwin" ? "seatbelt" : "bubblewrap", allowlist });
		assert.equal(refused.applied, false);
		assert.equal(refused.failClosed, true);
		assert.match(refused.reason ?? "", /glob|escape/i);
	}
	const missing = confineNativeChild({ enabled: true, cwd: root, backend: "missing", allowlist: ["allowed.txt"] });
	assert.equal(missing.applied, false);
	assert.equal(missing.failClosed, true);
	assert.match(missing.reason ?? "", /unavailable/i);
	const mismatched = confineNativeChild({ enabled: true, cwd: root, backend: process.platform === "darwin" ? "bubblewrap" : "seatbelt", allowlist: ["allowed.txt"] });
	assert.equal(mismatched.applied, false);
	assert.equal(mismatched.failClosed, true);
});

test("T6c policy is whole-process, direct-write, damage-control overlay and never rollback", () => {
	const policy = policyFor({ allowlist: ["src/allowed.ts"], runtimePaths: [".pi/runtime"], artifactPaths: [".pi/artifacts"] });
	assert.equal(policy.mechanism, process.platform === "darwin" ? "seatbelt" : "bubblewrap");
	assert.equal(policy.wholeProcessIncludingDescendants, true);
	assert.equal(policy.damageControlRole, "overlay");
	assert.equal(policy.directWritesOnly, true);
	assert.equal(policy.permissionExpansion, false);
	assert.equal(policy.rollsBackUserEdits, false);
	assert.equal(policy.protectsConcurrentUserWrites, false);
});

test("T6c macOS Seatbelt contract grants exact paths plus narrow null/tty devices only", () => {
	const root = fixture();
	const policy = confineNativeChild({ enabled: true, platform: "darwin", backend: "seatbelt", backendPath: "/usr/bin/sandbox-exec", cwd: root, allowlist: ["allowed.txt", "allowed-dir/"], runtimePaths: [join(root, "runtime")], artifactPaths: [join(root, "artifacts")], tempPaths: [join(root, "temp")], command: "/bin/sh", args: ["-c", "true"] });
	assert.equal(policy.applied, true);
	const exactFile = realpathSync(join(root, "allowed.txt")); const exactDirectory = realpathSync(join(root, "allowed-dir"));
	assert.match(policy.seatbeltProfile ?? "", new RegExp(`\\(literal \\"${exactFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"\\)`));
	assert.doesNotMatch(policy.seatbeltProfile ?? "", new RegExp(`\\(subpath \\"${exactFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"\\)`));
	assert.match(policy.seatbeltProfile ?? "", new RegExp(`\\(subpath \\"${exactDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"\\)`));
	assert.match(policy.seatbeltProfile ?? "", /\(literal "\/dev\/null"\)/);
	assert.match(policy.seatbeltProfile ?? "", /\(literal "\/dev\/tty"\)/);
	assert.doesNotMatch(policy.seatbeltProfile ?? "", /\(subpath "\/dev/);
});

test("T6c Darwin canonicalizes trusted runtime aliases such as /tmp to /private/tmp", () => {
	const root = fixture();
	const trustedAlias = join(root, "runtime-alias"); symlinkSync(join(root, "runtime"), trustedAlias);
	const trusted = confineNativeChild({ enabled: true, platform: "darwin", backend: "seatbelt", backendPath: "/usr/bin/sandbox-exec", cwd: root, allowlist: ["allowed.txt"], tempPaths: [trustedAlias] });
	assert.equal(trusted.applied, true, trusted.reason);
	assert.ok(trusted.writableDirectories?.includes(realpathSync(trustedAlias)));
	assert.equal(trusted.writableDirectories?.includes(trustedAlias), false);
});

test("T6c exact user allowlist paths retain strict symlink rejection", () => {
	const root = fixture();
	const exact = confineNativeChild({ enabled: true, platform: "darwin", backend: "seatbelt", backendPath: "/usr/bin/sandbox-exec", cwd: root, allowlist: ["allowed.txt"] });
	assert.equal(exact.applied, true, exact.reason); assert.deepEqual(exact.writableFiles, [realpathSync(join(root, "allowed.txt"))]);
	const userAlias = join(root, "user-alias"); symlinkSync(join(root, "allowed-dir"), userAlias);
	const refused = confineNativeChild({ enabled: true, platform: "darwin", backend: "seatbelt", backendPath: "/usr/bin/sandbox-exec", cwd: root, allowlist: ["user-alias/"] });
	assert.equal(refused.applied, false); assert.match(refused.reason ?? "", /symlink/i);
});

test("T6c empty approved grant set fails closed explicitly", () => {
	const root = fixture();
	const refused = confineNativeChild({ enabled: true, platform: "darwin", backend: "seatbelt", backendPath: "/usr/bin/sandbox-exec", cwd: root });
	assert.equal(refused.applied, false); assert.equal(refused.failClosed, true); assert.match(refused.reason ?? "", /no approved writable paths/i);
});

test("T6c sandbox spawn stdio invariant rejects inherited descriptors", () => {
	assert.doesNotThrow(() => assertSafeSandboxStdio(["pipe", "pipe", "pipe"]));
	assert.throws(() => assertSafeSandboxStdio(["pipe", "pipe", "pipe", 3] as any), /inherited file descriptors/i);
	assert.throws(() => assertSafeSandboxStdio(["inherit", "pipe", "pipe"] as any), /safe stdio/i);
});

test("T6c Darwin confineNativeChild uses production pipe stdio and denies extra writable inherited FD configuration", { skip: process.platform !== "darwin" }, () => {
	const root = fixture();
	const launch = shellLaunch(root, "printf exact > allowed.txt");
	assert.equal(launch.applied, true, launch.reason);
	assert.equal(launch.command, "/usr/bin/sandbox-exec");
	const productionStdio = ["pipe", "pipe", "pipe"] as const;
	assertSafeSandboxStdio(productionStdio);
	assert.throws(
		() => assertSafeSandboxStdio(["pipe", "pipe", "pipe", 3] as any),
		/inherited file descriptors/i,
	);
	const result = spawnSync(launch.command!, launch.args!, {
		cwd: launch.cwd,
		env: { ...process.env, ...launch.env },
		stdio: [...productionStdio],
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(root, "allowed.txt"), "utf8"), "exact");
	assert.equal(readFileSync(join(root, "blocked.txt"), "utf8"), "user-before");
});

test("T6c Darwin kernel boundary uses Hub confineNativeChild/sandbox-exec and blocks shell, node descendants and symlink escape", { skip: process.platform !== "darwin" }, () => {
	const root = fixture();
	const outside = mkdtempSync(join(tmpdir(), "fleet-t6c-outside-"));
	writeFileSync(join(outside, "secret"), "outside-before");
	symlinkSync(join(outside, "secret"), join(root, "allowed-dir", "escape"));
	const script = [
		"printf exact > allowed.txt",
		"printf created > allowed-dir/new.txt",
		"printf runtime > runtime/state",
		"(printf blocked > blocked.txt) 2>/dev/null && exit 41 || true",
		"(sh -c 'printf child > blocked-dir/child') 2>/dev/null && exit 42 || true",
		"(node -e \"require('fs').writeFileSync('blocked-dir/node','x')\") 2>/dev/null && exit 43 || true",
		"(printf escaped > allowed-dir/escape) 2>/dev/null && exit 44 || true",
	].join("; ");
	const launch = shellLaunch(root, script);
	assert.equal(launch.applied, true, launch.reason);
	assert.equal(launch.command, "/usr/bin/sandbox-exec");
	assert.match(launch.seatbeltProfile ?? "", /deny file-write\*/);
	const result = runLaunch(launch);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(root, "allowed.txt"), "utf8"), "exact");
	assert.equal(readFileSync(join(root, "blocked.txt"), "utf8"), "user-before");
	assert.equal(existsSync(join(root, "blocked-dir", "child")), false);
	assert.equal(existsSync(join(root, "blocked-dir", "node")), false);
	assert.equal(readFileSync(join(outside, "secret"), "utf8"), "outside-before");
});

test("T6c Darwin cancellation stops sandbox descendants writing the allowlisted pulse file", { skip: process.platform !== "darwin" }, async () => {
	const root = fixture();
	const launch = shellLaunch(root, "sh -c 'while :; do date +%s > allowed-dir/pulse; sleep 0.03; done' & wait");
	assert.equal(launch.applied, true, launch.reason);
	const child = spawn(launch.command!, launch.args!, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, detached: true, stdio: "ignore" });
	for (let i = 0; i < 40 && !existsSync(join(root, "allowed-dir", "pulse")); i++) await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(existsSync(join(root, "allowed-dir", "pulse")), true);
	killPiTree(child, "SIGTERM");
	await new Promise(resolve => child.once("close", resolve));
	const stoppedAt = readFileSync(join(root, "allowed-dir", "pulse"), "utf8");
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(readFileSync(join(root, "allowed-dir", "pulse"), "utf8"), stoppedAt);
});

test("T6c Linux kernel boundary blocks shell, python/indirect descendants and symlink escape while allowing exact files/new directory files/support roots", { skip: !hasLinuxSandbox }, () => {
	const root = fixture();
	const outside = mkdtempSync(join(tmpdir(), "fleet-t6c-outside-"));
	writeFileSync(join(outside, "secret"), "outside-before");
	symlinkSync(join(outside, "secret"), join(root, "allowed-dir", "escape"));
	const script = [
		"printf exact > allowed.txt",
		"printf created > allowed-dir/new.txt",
		"printf runtime > runtime/state",
		"printf artifact > artifacts/report",
		"printf temp > temp/work",
		"(printf blocked > blocked.txt) 2>/dev/null && exit 41 || true",
		"(sh -c 'printf child > blocked-dir/child') 2>/dev/null && exit 42 || true",
		"(node -e \"require('fs').writeFileSync('blocked-dir/node','x')\") 2>/dev/null && exit 43 || true",
		"(printf escaped > allowed-dir/escape) 2>/dev/null && exit 44 || true",
	].join("; ");
	const launch = shellLaunch(root, script);
	assert.equal(launch.writableDirectories?.includes(root), false, "the whole dispatch cwd must stay read-only");
	assert.equal(launch.writableDirectories?.includes(process.env.HOME ?? ""), false, "HOME must never be silently writable");
	const result = runLaunch(launch);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(root, "allowed.txt"), "utf8"), "exact");
	assert.equal(readFileSync(join(root, "allowed-dir", "new.txt"), "utf8"), "created");
	assert.equal(readFileSync(join(root, "blocked.txt"), "utf8"), "user-before");
	assert.equal(existsSync(join(root, "blocked-dir", "child")), false);
	assert.equal(existsSync(join(root, "blocked-dir", "node")), false);
	assert.equal(readFileSync(join(outside, "secret"), "utf8"), "outside-before");
	assert.equal(readFileSync(join(root, "runtime", "state"), "utf8"), "runtime");
	assert.equal(readFileSync(join(root, "artifacts", "report"), "utf8"), "artifact");
});

test("T6c actual spawnPiAgent transport wraps the fake Pi process and reports applied isolation", { skip: !hasLinuxSandbox }, async () => {
	const root = fixture();
	const fakePi = `#!/usr/bin/env node\nconst fs=require('node:fs'); const cp=require('node:child_process');\nfs.writeFileSync('allowed-dir/from-pi','ok');\ntry { fs.writeFileSync('blocked-dir/from-pi','bad'); } catch {}\ncp.spawnSync('/bin/sh',['-c','printf bad > blocked-dir/from-shell'],{stdio:'ignore'});\nprocess.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'isolated'}})+'\\n');`;
	writeFileSync(join(root, "pi"), fakePi, { mode: 0o755 });
	const result = await spawnPiAgent({
		model: "local/m", tools: "read,bash", thinking: "off", sessionFile: join(root, "runtime", "session"), prompt: "probe",
		cwd: root, detached: true, env: { PATH: `${root}:${process.env.PATH}`, TMPDIR: join(root, "temp") },
		writeIsolation: { enabled: true, cwd: root, allowlist: ["allowed-dir/"], runtimePaths: [join(root, "runtime")], artifactPaths: [join(root, "artifacts")], tempPaths: [join(root, "temp")] },
	});
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(result.output, "isolated"); assert.equal(result.writeIsolation?.applied, true);
	assert.equal(readFileSync(join(root, "allowed-dir", "from-pi"), "utf8"), "ok");
	assert.equal(existsSync(join(root, "blocked-dir", "from-pi")), false);
	assert.equal(existsSync(join(root, "blocked-dir", "from-shell")), false);
});

test("T6c concurrent user edits outside the allowlist are preserved", { skip: !hasLinuxSandbox }, async () => {
	const root = fixture();
	const launch = shellLaunch(root, "sleep 0.15; (printf sandbox > blocked.txt) 2>/dev/null || true; sleep 0.15");
	assert.equal(launch.applied, true, launch.reason);
	const child = spawn(launch.command!, launch.args!, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: "ignore" });
	await new Promise(resolve => setTimeout(resolve, 75));
	writeFileSync(join(root, "blocked.txt"), "user-concurrent");
	const code = await new Promise<number | null>(resolve => child.once("close", resolve));
	assert.equal(code, 0);
	assert.equal(readFileSync(join(root, "blocked.txt"), "utf8"), "user-concurrent");
});

test("T6c cancellation kills the sandbox process group and its writing descendant", { skip: !hasLinuxSandbox }, async () => {
	const root = fixture();
	const launch = shellLaunch(root, "sh -c 'while :; do date +%s%N > allowed-dir/pulse; sleep 0.03; done' & wait");
	assert.equal(launch.applied, true, launch.reason);
	const child = spawn(launch.command!, launch.args!, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, detached: true, stdio: "ignore" });
	for (let i = 0; i < 40 && !existsSync(join(root, "allowed-dir", "pulse")); i++) await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(existsSync(join(root, "allowed-dir", "pulse")), true);
	killPiTree(child, "SIGTERM");
	await new Promise(resolve => child.once("close", resolve));
	const stoppedAt = readFileSync(join(root, "allowed-dir", "pulse"), "utf8");
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(readFileSync(join(root, "allowed-dir", "pulse"), "utf8"), stoppedAt);
});

test("T6c a broken backend fails closed and never retries the command unsandboxed", { skip: process.platform !== "linux" }, () => {
	const root = fixture();
	const launch = shellLaunch(root, "printf unsafe > blocked.txt", { backendPath: "/bin/false" });
	const result = runLaunch(launch);
	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(join(root, "blocked.txt"), "utf8"), "user-before");
});
