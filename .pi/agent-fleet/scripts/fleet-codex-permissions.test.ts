import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repair } from "./fix-codex-permissions.ts";
import { createServer } from "node:net";
import test from "node:test";

test("operator repair is scoped to the selected release and repeatable", { skip: process.platform !== "linux" }, async t => {
	const home = mkdtempSync(join(tmpdir(), "codex-repair-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const standalone = join(home, "packages", "standalone");
	const name = "0.170.0-x86_64-unknown-linux-musl";
	const release = join(standalone, "releases", name);
	const current = join(standalone, "current");
	mkdirSync(release, { recursive: true, mode: 0o700 });
	symlinkSync(join("releases", name), current);
	const socketRoot = join(home, "sockets");
	mkdirSync(socketRoot, { mode: 0o700 });
	const socket = join(socketRoot, "a".repeat(64));
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
	t.after(() => server.close());
	chmodSync(socket, 0o600);
	const procRoot = join(home, "proc");
	mkdirSync(join(procRoot, "net"), { recursive: true });
	const inventory = join(procRoot, "net", "unix");
	writeFileSync(inventory, "");
	mkdirSync(join(release, "bin"), { mode: 0o700 });
	const marker = join(home, "started");
	writeFileSync(join(release, "bin", "codex"), [
		"#!/bin/sh", 'test "$*" = "app-server daemon start" || exit 2',
		'test ! -e "$CODEX_HOME/started" || exit 3', 'touch "$CODEX_HOME/started"',
		`echo '0: 0 0 00010000 0001 01 42 ${socket}' > "$CODEX_HOME/proc/net/unix"`,
	].join("\n"), { mode: 0o700 });
	const run = () => repair(home, { procRoot, socketRoot });
	chmodSync(release, 0o775);
	await run();
	assert.ok(existsSync(marker));
	assert.equal(statSync(release).mode & 0o7777, 0o755);
	await run();
	const control = join(home, "app-server-control");
	mkdirSync(control, {mode: 0o700});
	symlinkSync(marker, join(control, "app-server-control.sock"));
	await assert.rejects(run, /daemon_alias_unsafe/);
	unlinkSync(join(control, "app-server-control.sock"));
	writeFileSync(inventory, "");
	writeFileSync(join(release, "bin", "codex"), "#!/bin/sh\nexit 0\n");
	await assert.rejects(run, /desktop_discovery_daemon_unavailable after daemon start/);

	chmodSync(release, 0o777);
	await assert.rejects(run, /Unexpected writable release mode/);
	assert.equal(statSync(release).mode & 0o7777, 0o777);
	unlinkSync(current);
	symlinkSync(join(home, name), current);
	await assert.rejects(run, /Unexpected standalone release/);
	unlinkSync(current);
	symlinkSync(release, current);
	chmodSync(release, 0o775);
	chmodSync(standalone, 0o775);
	await assert.rejects(run, /Unsafe parent directory/);
	assert.equal(statSync(release).mode & 0o7777, 0o775);
});
