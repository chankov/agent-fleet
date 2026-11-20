// One-shot operator repair for the Linux standalone installer's release directory.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function repair(): void {
	if (process.platform !== "linux") throw new Error("This repair requires Linux.");
	const uid = process.getuid!();
	const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	if (resolve(home) !== home) throw new Error("CODEX_HOME must be an absolute canonical path.");
	const standalone = join(home, "packages", "standalone");
	const releases = join(standalone, "releases");
	for (let path = releases; ; path = dirname(path)) {
		const stat = lstatSync(path);
		const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
		if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) && !stickyRoot)) {
			throw new Error(`Unsafe parent directory: ${path}`);
		}
		if (path === dirname(path)) break;
	}
	const current = join(standalone, "current");
	const link = readlinkSync(current);
	const name = basename(link);
	const release = join(releases, name);
	const linuxRelease = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?-(?:x86_64|aarch64)-unknown-linux-(?:musl|gnu)$/;
	if ((link !== release && link !== join("releases", name)) || !linuxRelease.test(name)) {
		throw new Error(`Unexpected standalone release selected by ${current}`);
	}
	const fd = openSync(release, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		const mode = stat.mode & 0o7777;
		if (stat.uid !== uid) throw new Error(`Release directory belongs to another user: ${release}`);
		if (mode === 0o775) {
			fchmodSync(fd, 0o755);
		} else if (mode & 0o022) {
			throw new Error(`Unexpected writable release mode ${mode.toString(8)}: ${release}`);
		}
		const selected = lstatSync(release);
		if (readlinkSync(current) !== link || selected.dev !== stat.dev || selected.ino !== stat.ino ||
			(selected.mode & 0o022) !== 0) throw new Error("Release changed during repair. Run the command again.");
		console.log(mode === 0o775 ? `Fixed 0775 -> 0755: ${release}` : `Permissions already safe: ${release}`);
	} finally {
		closeSync(fd);
	}
}

try {
	repair();
} catch (error) {
	console.error(`fix-codex-permissions: ${error instanceof Error ? error.message : error}`);
	process.exitCode = 1;
}
