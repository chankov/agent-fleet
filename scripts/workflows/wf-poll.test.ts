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
import { pollWorkflow, pollWorkflowPreflight, pollWorkflowValidate } from "./wf-poll.ts";

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

test("poll dry-run runs request, parallel voices, collect, merge, and finishes once", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "wf-poll-"));
	try {
		const run = new Run({ cwd: runtime, runId: "poll-dry" });
		const result = await pollWorkflow(run, { args: ["should we use A?"], dryRun: true, cwd: runtime, panel: "default" }, { persona, voices });
		assert.equal(result.exitCode, 0);
		assert.equal(result.accepted, true);
		const starts = run.trace.events().filter(event => event.type === "phase_start");
		assert.equal(starts[0].phase, "request");
		assert.equal(starts[0].kind, "engineer");
		for (const voice of voices) {
			assert.ok(starts.some(event => event.phase === `poll-${voice.name}` && event.kind === "agent" && event.owner === voice.name));
		}
		assert.ok(starts.some(event => event.phase === "collect" && event.kind === "code"));
		assert.equal(starts.at(-1)?.phase, "merge");
		assert.equal(starts.at(-1)?.kind, "agent");
		assert.throws(() => run.finish({ accepted: true }), /exactly once/);
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("missing --panel is a start refusal that lists available panels", () => {
	assert.throws(() => pollWorkflowValidate({ args: ["question"] }, ROOT), error => {
		assert.equal((error as { exitCode?: number }).exitCode, 2);
		assert.match((error as Error).message, /requires --panel/);
		assert.match((error as Error).message, /default/);
		return true;
	});
});

test("missing question is a start refusal", () => {
	assert.throws(() => pollWorkflowValidate({ args: [], panel: "default" }, ROOT), error => {
		assert.equal((error as { exitCode?: number }).exitCode, 2);
		assert.match((error as Error).message, /requires a question/);
		return true;
	});
});

test("preflight refuses when a panel model is not visible to a clean-room child", () => {
	assert.throws(() => pollWorkflowPreflight(ROOT, { name: "poll", args: ["q"], allowDirty: false, dryRun: false, panel: "default" }, {
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
		assert.match((error as Error).message, /openai-codex\/gpt-5\.6-sol/);
		return true;
	});
});

test("acceptance is tied to a merge result", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "wf-poll-nomerge-"));
	try {
		const run = new Run({ cwd: runtime, runId: "poll-nomerge" });
		const result = await pollWorkflow(run, { args: ["A or B?"], dryRun: true, cwd: runtime, panel: "default" }, {
			persona, voices: voices.map(voice => ({ ...voice, integrator: undefined })),
		});
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /no voice with integrator: true/);
		assert.equal(ENVELOPE_EXAMPLES.merge.recommendation.length > 0, true);
	} finally { rmSync(runtime, { recursive: true, force: true }); }
});
