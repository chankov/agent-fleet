// Offline source contract only. Never import the user-run live harness here.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const source = readFileSync(new URL("./task-triage-live-stage-closure.user-run.mjs", import.meta.url), "utf8");

test("live review prompts and closure require the same standalone canonical verdict", () => {
  assert.match(source, /name === "code-reviewer" \? "Start your final return with exactly one standalone line: VERDICT: APPROVE or VERDICT: REJECT/);
  assert.match(source, /Start your final return with exactly one standalone line, VERDICT: APPROVE only if/);
  assert.match(source, /review\.result\.output\.split\(\/\\r\?\\n\/, 1\)\[0\]/);
  assert.match(source, /reviewClosureUnmet\(\{ process: review\.acceptance\.process, verdict: reviewVerdict,/);
  assert.doesNotMatch(source, /\/VERDICT:\\s\*APPROVE\\b\/i\.test\(review\.result\.output\)/);
});

test("planner readback and pre-builder byte/status gates prevent false stage closure", () => {
  assert.match(source, /plan\.acceptance\.readback\?\.length !== 1/);
  assert.match(source, /plan\.acceptance\.readback\[0\]\.status !== "read"/);
  assert.match(source, /plan\.acceptance\.readback\[0\]\.changed !== true/);
  assert.match(source, /plan\.acceptance\.readback\[0\]\.path !== planArtifact/);
  assert.match(source, /!existsSync\(planArtifact\) \|\| !readFileSync\(planArtifact, "utf8"\)\.trim\(\)/);
  assert.match(source, /planNonRuntimeStatus = nonRuntimeStatus\(planStatus\.stdout/);
  assert.match(source, /readmeUnchanged: readFileSync\(readme, "utf8"\) === initial/);
  assert.match(source, /planNonRuntimeStatus !== "" \|\| !outcome\.afterPlan\.readmeUnchanged \|\| !planUnchangedFixture/);
  assert.ok(source.indexOf('throw new Error("planner changed README') < source.indexOf("const two = await request(p2)"));
});

test("explicit absolute session plan is the single declared deliverable, distinct from generic auto-handoff", () => {
  assert.match(source, /const planArtifact = join\(sessionsRoot, planSessions\[0\], "artifacts\/plans\/synthetic-readme-fix\.md"\)/);
  assert.match(source, /writeFileSync\(planPath, planArtifact\)/);
  assert.match(source, /planDeliverable: \(\) => readFileSync\(process\.env\.T4_LIVE_PLAN!/);
  assert.match(source, /name === "planner" \? "For this synthetic task, write the plan to the absolute path declared in dispatch deliverables/);
  assert.match(source, /deliverables \["\$\{planArtifact\}"\]/);
  assert.match(source, /explicit absolute deliverable \$\{planArtifact\}/);
  assert.match(source, /plan\.acceptance\.readback\[0\]\.path !== planArtifact/);
  assert.doesNotMatch(source, /const planArtifact = "artifacts\/plan\//);
  assert.ok(source.indexOf("const planArtifact = join(") < source.indexOf("const planned = await request(pPlan)"));
});

test("child identity is observed from retained session, not inferred from requested model", () => {
  assert.match(source, /row\.type === "message" && row\.message\?\.role === "assistant"/);
  assert.match(source, /status: "unavailable", reason: "no complete assistant model identity/);
  assert.match(source, /modelEvidence: \{ \.\.\.childModel/);
  assert.match(source, /childModel\.identities\.some\(m => `\$\{m\.provider\}\/\$\{m\.model\}` !== model\)/);
  assert.match(source, /Object\.hasOwn\(result\.diagnostics, "modelFallback"\)/);
  assert.match(source, /result\.diagnostics\.modelFallback !== null/);
  assert.doesNotMatch(source, /result\.diagnostics\?\.modelUsed !== model/);
});

test("review requires actual parsed assertion evidence, not merely a verdict or invented artifact", () => {
  assert.match(source, /parsed: review\.acceptance\.structuredReturn, requiredPaths: reviewPaths/);
  assert.match(source, /if \(unmet\.length\) throw new Error\(`review closure unmet: /);
  assert.match(source, /REVIEW INSTRUCTIONS \/ TEMPLATE ONLY/);
  assert.match(source, /You are read-only: do not promise or cite a new review artifact/);
});

test("review consumes retained dispatch evidence and existing absolute inputs", () => {
  assert.match(source, /result\.evidencePath !== canonicalResultPath/);
  assert.match(source, /resultPath: result\.evidencePath/);
  assert.match(source, /const reviewInputs = \[plan\.returnPath, readme, before, after, beforeDiff, afterDiff,[\s\S]*?build\.acceptancePath, checkEvidence\.evidenceRef, build\.resultPath\];/);
  assert.match(source, /if \(typeof path !== "string" \|\| !existsSync\(path\)\) throw new Error\(`Reviewer input unavailable before dispatch:/);
  assert.match(source, /const p3 = `[\s\S]*?absolute canonical dispatch evidence path \$\{build\.resultPath\}/);
});
