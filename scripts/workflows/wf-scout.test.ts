import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ENVELOPE_EXAMPLES, type ScoutReport } from "./lib/envelopes.ts";
import type { PersonaDefinition } from "./lib/personas.ts";
import { Run } from "./lib/run.ts";
import { SCOUT_PERMISSION_POLICY, scoutWorkflow, scoutWorkflowPreflight } from "./wf-scout.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("scout workflow executes engineer then read-only scout and accepts a valid envelope", async () => {
	scoutWorkflowPreflight(ROOT);
	const runtime = mkdtempSync(join(tmpdir(), "wf-scout-"));
	try {
		const run = new Run({ cwd: runtime, runId: "scout-dry" });
		const result = await scoutWorkflow(run, { args: ["where", "does X live?"], dryRun: true, cwd: ROOT });
		assert.equal(result.exitCode, 0);
		const phases = run.trace.events().filter(event => event.type === "phase_start").map(event => [event.phase, event.kind, event.owner]);
		assert.deepEqual(phases, [["request", "engineer", "operator"], ["scout", "agent", "researcher"]]);
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("scout supplies an explicit read-only runtime policy when the persona has no writes declaration", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "wf-scout-policy-"));
	const persona: PersonaDefinition = {
		name: "researcher", description: "read only", tools: "read,grep,find,ls", model: "provider/model",
		systemPrompt: "Research only", file: "agents/researcher.md",
	};
	try {
		const run = new Run({ cwd: runtime, runId: "scout-policy" });
		let seenPolicy: unknown;
		const result = await scoutWorkflow(run, { args: ["locate X"], dryRun: false, cwd: ROOT }, {
			persona,
			agent: async options => {
				seenPolicy = options.permissionPolicy;
				return ENVELOPE_EXAMPLES.scout as ScoutReport;
			},
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(seenPolicy, SCOUT_PERMISSION_POLICY);
		assert.deepEqual(SCOUT_PERMISSION_POLICY, { writes: [] });
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});
