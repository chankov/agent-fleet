import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAgentTeamOverrides } from "../../../../../.pi/harnesses/agent-hub/config/overrides.ts";
import { readProjectPolicy, resolveProjectPolicy } from "./project-policy.ts";

test("workflow policy reader matches Hub sections, commas, last value, and preserves explicit paths", () => {
 const cwd = mkdtempSync(join(tmpdir(), "workflow-policy-parity-"));
 try {
  mkdirSync(join(cwd, ".ai"));
  writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "## workflows\nquality: npm test\nrules: ignored\n## AGENT-TEAM\nrules: .ai/old\n## agent-hub\nRules: .ai/rules, docs/rules\ndocs: docs/start.md, docs/guide\n## other\nrules: ignored\n");
  assert.deepEqual(readProjectPolicy(cwd), { rulesPaths: parseAgentTeamOverrides(cwd).rulesDirs, docsPaths: parseAgentTeamOverrides(cwd).docsPaths });
  const warnings: string[] = [];
  const merged = resolveProjectPolicy(cwd, { rulesPaths: [".ai/rules", "extra"], docsPaths: ["other"] }, message => warnings.push(message));
  assert.deepEqual(merged, { rulesPaths: [".ai/rules", "docs/rules", "extra"], docsPaths: ["docs/start.md", "docs/guide", "other"] });
  assert.equal(warnings.length, 6, "missing entries warn once per unique path but do not abort");
  assert.deepEqual(resolveProjectPolicy(cwd, {}, () => {}), readProjectPolicy(cwd), "omitting explicit paths does not wipe repo policy");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("missing rules and docs paths warn and continue without failing workflow setup", () => {
 const cwd = mkdtempSync(join(tmpdir(), "workflow-policy-missing-"));
 try {
  mkdirSync(join(cwd, ".ai"));
  writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "## agent-hub\nrules: missing-rules\ndocs: missing-docs\n");
  const warnings: string[] = [];
  assert.deepEqual(resolveProjectPolicy(cwd, {}, message => warnings.push(message)), { rulesPaths: ["missing-rules"], docsPaths: ["missing-docs"] });
  assert.match(warnings[0], /rules folder.*missing-rules.*not found/);
  assert.match(warnings[1], /docs entry point.*missing-docs.*not found/);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});
