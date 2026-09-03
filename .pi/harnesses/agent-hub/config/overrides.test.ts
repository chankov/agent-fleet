import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAgentTeamOverrides } from "./overrides.ts";

test("research-keep is ignored with a removal warning and has no runtime field", () => {
	const dir = mkdtempSync(join(tmpdir(), "overrides-research-keep-"));
	try {
		mkdirSync(join(dir, ".ai"), { recursive: true });
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub
research-keep: 8
language: Bulgarian
`);
		const overrides = parseAgentTeamOverrides(dir);
		assert.equal((overrides as { researchKeep?: unknown }).researchKeep, undefined);
		assert.ok(overrides.warnings.some(warning => /research-keep is removed/.test(warning)));
		assert.equal(overrides.language, "Bulgarian");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
