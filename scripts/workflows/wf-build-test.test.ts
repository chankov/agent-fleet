import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENVELOPE_EXAMPLES } from "./lib/envelopes.ts";
import type { PersonaDefinition } from "./lib/personas.ts";
import type { PermissionSnapshot } from "./lib/permissions.ts";
import type { QualityResult } from "./lib/quality.ts";
import { Run } from "./lib/run.ts";
import { buildTestWorkflow, type BuildReport } from "./wf-build-test.ts";

const persona: PersonaDefinition = { name: "builder", description: "build", tools: "read,write,edit,bash", model: "stub/model", models: [], thinking: "low", systemPrompt: "", file: "agents/builder.md" };
function baseline(cwd: string): PermissionSnapshot { return { cwd, paths: new Map() }; }
function quality(passed: boolean, text: string): QualityResult { return { argv: ["stub-test"], exitCode: passed ? 0 : 1, stdout: "", stderr: text, logPath: "/tmp/command.log", passed }; }

test("build-test follows build, red evidence, same builder fix, green verification, then one commit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-build-test-"));
	try {
		const run = new Run({ cwd, runId: "build-green" }); const tasks: string[] = []; let tests = 0, commits = 0;
		const result = await buildTestWorkflow(run, { args: ["implement X"], dryRun: false, cwd }, {
			persona, baseline: baseline(cwd),
			agent: async options => {
				assert.deepEqual(options.permissionPolicy, { writes: ["**"] });
				tasks.push(options.task);
				return { ...ENVELOPE_EXAMPLES.build, commit_message: "feat: x" } as BuildReport;
			},
			tests: async () => ++tests === 1 ? quality(false, "EXACT RED OUTPUT") : quality(true, ""),
			commit: () => { commits++; return "abc"; },
		});
		assert.equal(result.exitCode, 0); assert.equal(commits, 1); assert.equal(tasks.length, 2); assert.ok(tasks[1].includes("EXACT RED OUTPUT"));
		assert.deepEqual(run.trace.events().filter(event => event.type === "phase_start").map(event => event.phase), ["request", "build", "test", "builder-fix-1", "test-after-fix-1", "commit"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("build-test exits one without commit after bounded fixes are exhausted", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-build-fail-"));
	try {
		const run = new Run({ cwd, runId: "build-fail" }); let agents = 0, commits = 0;
		const result = await buildTestWorkflow(run, { args: ["implement X"], dryRun: false, cwd }, {
			persona, baseline: baseline(cwd), maxFixAttempts: 2,
			agent: async options => { assert.deepEqual(options.permissionPolicy, { writes: ["**"] }); agents++; return ENVELOPE_EXAMPLES.build as BuildReport; },
			tests: async () => quality(false, "still red"),
			commit: () => { commits++; return "bad"; },
		});
		assert.equal(result.exitCode, 1); assert.equal(agents, 3); assert.equal(commits, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
