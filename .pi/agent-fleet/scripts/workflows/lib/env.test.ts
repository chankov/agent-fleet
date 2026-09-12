import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv, parseEnv } from "./env.ts";

test("parseEnv handles exports, quotes, comments, and escapes", () => {
	assert.deepEqual(parseEnv("# x\nA=one\nexport B='two words'\nC=three # comment\nD=\"line\\nnext\"\n"), { A: "one", B: "two words", C: "three", D: "line\nnext" });
});

test("loadEnv reads repo-root .env without overwriting inherited values", () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-env-"));
	try {
		writeFileSync(join(cwd, ".env"), "KEEP=file\nNEW=value\n");
		const env: NodeJS.ProcessEnv = { KEEP: "operator" };
		assert.deepEqual(loadEnv(cwd, env), { NEW: "value" });
		assert.equal(env.KEEP, "operator");
		assert.equal(env.NEW, "value");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
