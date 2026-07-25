import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isCorruptSessionExit, isUsablePiSession, quarantineIfUnusable, quarantineName } from "./session-health.js";

// Shapes taken verbatim from real files: a healthy session opens with the
// header record, the two pi rejected in the field open with a message record.
const HEADER = '{"type":"session","version":3,"id":"019f950f-aba5","timestamp":"2026-07-24T16:57:40.005Z","cwd":"/repo"}';
const MESSAGE = '{"type":"message","id":"5f82b8ad","parentId":"fed267e3","message":{"role":"toolResult"}}';
const VALID_SESSION = `${HEADER}\n${MESSAGE}\n`;

const io = { existsSync, readFileSync, renameSync };

function withTmpDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "session-health-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("isUsablePiSession accepts a file that opens with the session header", () => {
	assert.deepEqual(isUsablePiSession(VALID_SESSION), { ok: true, reason: null });
	// Leading blank lines are cosmetic, not corruption.
	assert.equal(isUsablePiSession(`\n\n${VALID_SESSION}`).ok, true);
});

test("isUsablePiSession rejects a file truncated at the head", () => {
	// The `builder.json.invalid-gate-p` case: valid JSONL, no session header.
	const verdict = isUsablePiSession(`${MESSAGE}\n`);
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /not a "session" header/);
});

test("isUsablePiSession rejects empty and unparseable files", () => {
	assert.equal(isUsablePiSession("").ok, false);
	assert.equal(isUsablePiSession("   \n\n").ok, false);
	assert.match(isUsablePiSession("").reason, /empty/);

	const broken = isUsablePiSession('{"type":"session", trunca');
	assert.equal(broken.ok, false);
	assert.match(broken.reason, /not valid JSON/);

	assert.equal(isUsablePiSession("[]").ok, false);
	assert.equal(isUsablePiSession("null").ok, false);
});

test("quarantineName stamps the file without colons", () => {
	const name = quarantineName("/s/builder.json", new Date("2026-07-25T09:14:02.123Z"));
	assert.equal(name, "/s/builder.json.corrupt-2026-07-25T09-14-02-123Z");
	assert.equal(name.includes(":"), false);
});

test("quarantineIfUnusable leaves a healthy session in place", () => {
	withTmpDir((dir) => {
		const file = join(dir, "builder.json");
		writeFileSync(file, VALID_SESSION, "utf-8");

		assert.deepEqual(quarantineIfUnusable(file, io), { usable: true, quarantined: null, reason: null });
		assert.equal(existsSync(file), true);
		assert.equal(readdirSync(dir).length, 1);
	});
});

test("quarantineIfUnusable moves a corrupt session aside and preserves it", () => {
	withTmpDir((dir) => {
		const file = join(dir, "builder.json");
		writeFileSync(file, `${MESSAGE}\n`, "utf-8");

		const result = quarantineIfUnusable(file, { ...io, now: () => new Date("2026-07-25T09:14:02.123Z") });
		assert.equal(result.usable, false);
		assert.equal(result.quarantined, `${file}.corrupt-2026-07-25T09-14-02-123Z`);
		assert.match(result.reason, /truncated at the head/);

		// The original path is free for a clean run, and nothing was destroyed.
		assert.equal(existsSync(file), false);
		assert.equal(readFileSync(result.quarantined, "utf-8"), `${MESSAGE}\n`);
	});
});

test("quarantineIfUnusable reports a missing file as unusable without quarantining", () => {
	withTmpDir((dir) => {
		const result = quarantineIfUnusable(join(dir, "absent.json"), io);
		assert.deepEqual(result, { usable: false, quarantined: null, reason: null });
	});
});

test("isCorruptSessionExit matches only the observed signature", () => {
	const stderr = "Error: Session file is not a valid pi session: /s/builder.json";
	assert.equal(isCorruptSessionExit({ code: 1, output: "", stderr }), true);
	assert.equal(isCorruptSessionExit({ code: 1, output: "   \n", stderr }), true);

	// A successful run is never a corrupt session, whatever stderr says.
	assert.equal(isCorruptSessionExit({ code: 0, output: "", stderr }), false);
	// Work was produced — retrying would repeat it.
	assert.equal(isCorruptSessionExit({ code: 1, output: "I edited foo.ts", stderr }), false);
	// Unrelated failures (bad model, missing API key) must never auto-retry.
	assert.equal(isCorruptSessionExit({ code: 1, output: "", stderr: "unknown model 'gpt-9'" }), false);
	assert.equal(isCorruptSessionExit({}), false);
});
