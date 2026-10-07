import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizePolicyPath } from "../../lib/policy-roots.ts";
import test from "node:test";
import { parseAgentTeamOverrides } from "./overrides.ts";
import { normalizeWatchdogSystem1Mode } from "../system1-runtime.ts";

test("Hub policy loading resolves sibling roots once against the checkout and surfaces missing grants", t => {
 const base = mkdtempSync(join(tmpdir(), "overrides-policy-"));
 t.after(() => rmSync(base, { recursive: true, force: true }));
 const checkout = join(base, "checkout");
 mkdirSync(join(checkout, ".ai"), { recursive: true });
 mkdirSync(join(checkout, "nested"));
 mkdirSync(join(base, "docs/rules"), { recursive: true });
 writeFileSync(join(base, "docs/README.md"), "docs");
 writeFileSync(join(checkout, ".ai/agent-fleet-overrides.md"), "## agent-hub\nrules: ../docs/rules\ndocs: ../docs/README.md, ../missing\n");
 const overrides = parseAgentTeamOverrides(checkout);
 assert.deepEqual(overrides.rulesDirs, ["../docs/rules"]);
 assert.deepEqual(overrides.docsPaths, ["../docs/README.md", "../missing"]);
 assert.ok(overrides.policyRoots);
 assert.equal(authorizePolicyPath(overrides.policyRoots!, "../docs/README.md").path, join(base, "docs/README.md"));
 assert.ok(overrides.warnings.some(w => w.includes("missing_root:../missing")));
 const defaults = parseAgentTeamOverrides(join(checkout, "nested"));
 assert.equal(defaults.policyRoots?.workspace, join(checkout, "nested"));
 assert.equal(defaults.policyRoots?.roots.length, 1);
});

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

test("legacy watchdog-system1 Markdown is ignored; v2 owns runtime configuration", () => {
	const dir = mkdtempSync(join(tmpdir(), "overrides-watchdog-system1-"));
	try {
		mkdirSync(join(dir, ".ai"), { recursive: true });
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: sideways\nwatchdog: auto\n`);
		const invalid = parseAgentTeamOverrides(dir);
		assert.equal(invalid.watchdogSystem1Mode, "off");
		assert.equal(invalid.watchdogSetting, "auto");
		assert.equal(invalid.warnings.filter((warning) => warning.includes("watchdog-system1")).length, 0);
		const again = parseAgentTeamOverrides(dir);
		again.warnings.push("not from the parser");
		assert.equal(invalid.warnings.length, 0);
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: ACTIVE\n`);
		assert.equal(parseAgentTeamOverrides(dir).watchdogSystem1Mode, "off");
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nwatchdog-system1: shadow\n`);
		const shadow = parseAgentTeamOverrides(dir);
		assert.equal(shadow.watchdogSystem1Mode, "off");
		assert.equal(shadow.warnings.length, 0);
		assert.equal(parseAgentTeamOverrides(mkdtempSync(join(tmpdir(), "overrides-watchdog-system1-default-"))).watchdogSystem1Mode, "off");
		assert.equal(normalizeWatchdogSystem1Mode(" Shadow ").mode, "shadow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
