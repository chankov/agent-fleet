import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWriterLease, releaseWriterLease, withWriterLease, writerLeaseFile, writerLeaseMode, WriterLeaseHeldError } from "./writer-lease.ts";

function repo() {
	const cwd = mkdtempSync(join(tmpdir(), "lease-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "README.md"), "ok\n");
	return cwd;
}

test("acquire is atomic; a live owner is named and a dead owner is stolen", () => {
	const cwd = repo();
	try {
		const first = acquireWriterLease({ cwd, owner: "merge:opus", command: "just flow poll --apply" });
		assert.equal(existsSync(first.file), true);
		assert.equal(writerLeaseMode(first.file), 0o600);
		assert.equal(first.file, writerLeaseFile(cwd));
		assert.throws(() => acquireWriterLease({ cwd, owner: "merge:sol", command: "just flow poll --apply #2" }), error => (
			error instanceof WriterLeaseHeldError
			&& error.message.includes("merge:opus")
			&& error.message.includes("just flow poll --apply")
			&& error.message.includes(first.file)
			&& !error.message.includes("#2")
		));
		releaseWriterLease(first);
		assert.equal(existsSync(first.file), false);

		writeFileSync(first.file, `${JSON.stringify({
			owner: "merge:ghost", pid: 999_999_999, command: "dead-owner poll --apply", path: cwd, createdAt: new Date().toISOString(),
		})}\n`, { flag: "wx", mode: 0o600 });
		const stolen = acquireWriterLease({ cwd, owner: "merge:opus", command: "just flow poll --apply" });
		assert.equal(stolen.record.owner, "merge:opus");
		assert.equal(stolen.record.command, "just flow poll --apply");
		releaseWriterLease(stolen);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("release from a non-owner is a no-op and withWriterLease always releases", async () => {
	const cwd = repo();
	try {
		const owned = acquireWriterLease({ cwd, owner: "merge:opus", command: "owner" });
		releaseWriterLease({ file: owned.file, record: { ...owned.record, pid: owned.record.pid + 1, owner: "other" } });
		assert.equal(existsSync(owned.file), true);
		releaseWriterLease(owned);
		assert.equal(existsSync(owned.file), false);

		await assert.rejects(withWriterLease({ cwd, owner: "merge:opus", command: "boom" }, async lease => {
			assert.equal(existsSync(lease.file), true);
			throw new Error("phase exploded");
		}), /phase exploded/);
		assert.equal(existsSync(writerLeaseFile(cwd)), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
