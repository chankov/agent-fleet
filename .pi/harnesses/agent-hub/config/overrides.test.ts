import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAgentTeamOverrides } from "./overrides.ts";
import { normalizeWatchdogSystem1Mode } from "../system1-runtime.ts";

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

test("watchdog-system1 defaults off, accepts shadow and active, and warns once per parse for an invalid mode", () => {
	const dir = mkdtempSync(join(tmpdir(), "overrides-watchdog-system1-"));
	try {
		mkdirSync(join(dir, ".ai"), { recursive: true });
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: sideways\nwatchdog: auto\n`);
		const invalid = parseAgentTeamOverrides(dir);
		assert.equal(invalid.watchdogSystem1Mode, "off");
		assert.equal(invalid.watchdogSetting, "auto");
		assert.equal(invalid.warnings.filter((warning) => warning.includes("watchdog-system1")).length, 1);
		const again = parseAgentTeamOverrides(dir);
		again.warnings.push("not from the parser");
		assert.equal(invalid.warnings.length, 1);
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: ACTIVE\n`);
		assert.equal(parseAgentTeamOverrides(dir).watchdogSystem1Mode, "active");
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: shadow\n`);
		const shadow = parseAgentTeamOverrides(dir);
		assert.equal(shadow.watchdogSystem1Mode, "shadow");
		assert.equal(shadow.warnings.length, 0);
		assert.equal(parseAgentTeamOverrides(mkdtempSync(join(tmpdir(), "overrides-watchdog-system1-default-"))).watchdogSystem1Mode, "off");
		assert.equal(normalizeWatchdogSystem1Mode(" Shadow ").mode, "shadow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
