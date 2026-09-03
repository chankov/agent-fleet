import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ENVELOPE_EXAMPLES } from "./lib/envelopes.ts";
import type { PersonaDefinition } from "./lib/personas.ts";
import { Run } from "./lib/run.ts";
import type { Voice } from "./lib/voices.ts";
import { debateWorkflow, debateWorkflowPreflight, debateWorkflowValidate } from "./wf-debate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls", model: "provider/model",
	systemPrompt: "Research only", file: "agents/researcher.md", writes: [],
};
const voices: Voice[] = [
	{ name: "sol", model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	{ name: "grok", model: "xai/grok-4.6", thinking: "medium" },
	{ name: "opus", model: "github-copilot/claude-opus-5", thinking: "medium", integrator: true },
];

test("debate dry-run runs request, per-round voices, collect, and finishes once with no merge", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "wf-debate-"));
	try {
		const run = new Run({ cwd: runtime, runId: "debate-dry" });
		const result = await debateWorkflow(run, { args: ["should we use A?"], dryRun: true, cwd: runtime, panel: "default", rounds: 2 }, { persona, voices });
		assert.equal(result.exitCode, 0);
		assert.equal(result.accepted, true);
		const starts = run.trace.events().filter(event => event.type === "phase_start").map(event => event.phase);
		assert.equal(starts[0], "request");
		assert.ok(starts.includes("debate-sol-r1"));
		assert.ok(starts.includes("collect-r1"));
		assert.ok(starts.includes("debate-sol-r2"));
		assert.ok(starts.includes("collect-r2"));
		assert.equal(starts.some(phase => phase === "merge"), false);
		assert.throws(() => run.finish({ accepted: true }), /exactly once/);
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("missing --panel is a start refusal that lists available panels", () => {
	assert.throws(() => debateWorkflowValidate({ args: ["question"] }, ROOT), error => {
		assert.equal((error as { exitCode?: number }).exitCode, 2);
		assert.match((error as Error).message, /requires --panel/);
		assert.match((error as Error).message, /default/);
		return true;
	});
});

test("missing question, bad --rounds, and --apply are start refusals", () => {
	assert.throws(() => debateWorkflowValidate({ args: [], panel: "default" }, ROOT), /requires a question/);
	assert.throws(() => debateWorkflowValidate({ args: ["q"], panel: "default", rounds: 1 }, ROOT), /from 2 to 5/);
	assert.throws(() => debateWorkflowValidate({ args: ["q"], panel: "default", apply: true }, ROOT), /does not take --apply/);
});

test("preflight refuses when a panel model is not visible to a clean-room child", () => {
	assert.throws(() => debateWorkflowPreflight(ROOT, { name: "debate", args: ["q"], allowDirty: false, dryRun: false, panel: "default" }, {
		voices,
		checkVisibility: models => ({
			models: models.map(model => ({
				model, ok: false, failed: ["child-visible"],
				reasons: [`${model}: child-visible check failed — not listed`],
			})),
		}),
	}), error => {
		assert.equal((error as { exitCode?: number }).exitCode, 3);
		assert.match((error as Error).message, /not visible to a clean-room child/);
		return true;
	});
});

test("acceptance is tied to at least two surviving voices", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "wf-debate-few-"));
	try {
		const run = new Run({ cwd: runtime, runId: "debate-few" });
		const result = await debateWorkflow(run, { args: ["A or B?"], dryRun: true, cwd: runtime, panel: "default" }, {
			persona, voices: voices.slice(0, 1),
		});
		assert.equal(result.accepted, false);
		assert.equal(ENVELOPE_EXAMPLES.debate.position.length > 0, true);
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});
