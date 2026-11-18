import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("operator repair is scoped to the selected release and repeatable", { skip: process.platform !== "linux" }, t => {
	const home = mkdtempSync(join(tmpdir(), "codex-repair-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const standalone = join(home, "packages", "standalone");
	const name = "0.170.0-x86_64-unknown-linux-musl";
	const release = join(standalone, "releases", name);
	const current = join(standalone, "current");
	mkdirSync(release, { recursive: true, mode: 0o700 });
	symlinkSync(join("releases", name), current);
	const script = fileURLToPath(new URL("./fix-codex-permissions.ts", import.meta.url));
	const run = () => spawnSync(process.execPath, ["--experimental-strip-types", script], {
		env: { ...process.env, CODEX_HOME: home }, encoding: "utf8",
	});
	chmodSync(release, 0o775);
	const fixed = run();
	assert.equal(fixed.status, 0, fixed.stderr);
	assert.equal(statSync(release).mode & 0o7777, 0o755);
	assert.match(run().stdout, /already safe/);

	chmodSync(release, 0o777);
	assert.equal(run().status, 1);
	assert.equal(statSync(release).mode & 0o7777, 0o777);
	unlinkSync(current);
	symlinkSync(join(home, name), current);
	assert.equal(run().status, 1);
	unlinkSync(current);
	symlinkSync(release, current);
	chmodSync(release, 0o775);
	chmodSync(standalone, 0o775);
	assert.equal(run().status, 1);
	assert.equal(statSync(release).mode & 0o7777, 0o775);
});
