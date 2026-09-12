import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SpawnAgent } from "./agent-phase.ts";
import { ENVELOPE_EXAMPLES, type MergeReport, type PollReport } from "./envelopes.ts";
import { MERGE_APPLY_TOOLS, MergeUnavailableError, mergeTask, runMerge } from "./merge.ts";
import { POLL_TOOLS } from "./poll.ts";
import { acquireWriterLease, releaseWriterLease, WriterLeaseHeldError } from "./writer-lease.ts";
import type { PersonaDefinition } from "./personas.ts";
import { pollVoice } from "./poll.ts";
import { Run } from "./run.ts";
import type { Voice } from "./voices.ts";

const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls", model: "primary/model",
	fallbackModel: "fallback/model", thinking: "low", systemPrompt: "Merge.", file: "agents/researcher.md", writes: [],
};
const voices: Voice[] = [
	{ name: "sol", model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	{ name: "grok", model: "xai/grok-4.6", thinking: "medium" },
	{ name: "opus", model: "github-copilot/claude-opus-5", thinking: "medium", integrator: true },
];

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "integrator-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return { cwd, run: new Run({ cwd, runId: "merge-test" }) };
}

test("merge uses the integrator voice in a new session and attributes every claim", async () => {
	const { cwd, run } = fixture();
	try {
		const sessions: string[] = [];
		const spawn: SpawnAgent = async options => {
			sessions.push(options.sessionFile);
			if (!options.prompt.includes("Merge the independent poll opinions")) {
				return { output: JSON.stringify(ENVELOPE_EXAMPLES.poll), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
			}
			assert.equal(options.model, "github-copilot/claude-opus-5");
			assert.equal(options.tools, "read,grep,find,ls");
			assert.match(options.prompt, /must name a voice/);
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.merge), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const opinions = [];
		for (const voice of voices) opinions.push(await pollVoice({ run, cwd, persona, voice, task: "A or B?", panel: "default", spawn }));
		const pollSession = sessions.find(path => /claude-opus-5-opus/.test(path));
		const merged = await runMerge({ run, cwd, persona, panel: "default", task: "A or B?", opinions, voices, spawn });
		assert.equal(merged.integrator.name, "opus");
		assert.equal(existsSync(merged.path), true);
		const mergeSession = sessions.find(path => /claude-opus-5-merge/.test(path));
		assert.ok(pollSession, `poll session missing in ${sessions.join(", ")}`);
		assert.ok(mergeSession, `merge session missing in ${sessions.join(", ")}`);
		assert.notEqual(dirname(pollSession), dirname(mergeSession));
		const report = merged.report as MergeReport;
		for (const item of [...report.consensus, ...report.divergence, ...report.minority]) assert.ok(item.voice);
		for (const item of report.rejected) {
			assert.ok(item.voice);
			assert.ok(item.reason);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a panel without an integrator makes merge unavailable", async () => {
	const { cwd, run } = fixture();
	try {
		const noIntegrator = voices.map(voice => ({ ...voice, integrator: undefined }));
		await assert.rejects(runMerge({
			run, cwd, persona, panel: "silent", task: "A or B?", voices: noIntegrator,
			opinions: [{ ok: true, voice: voices[0], report: ENVELOPE_EXAMPLES.poll as PollReport, path: "x" }],
		}), error => error instanceof MergeUnavailableError && /no voice with integrator: true/.test(error.message));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("without --apply merge stays read-only; with --apply only the integrator gets write tools behind a lease", async () => {
	const { cwd, run } = fixture();
	try {
		const tools: string[] = [];
		const spawn: SpawnAgent = async options => {
			tools.push(options.tools);
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.merge), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const opinions = [{ ok: true as const, voice: voices[0], report: ENVELOPE_EXAMPLES.poll as PollReport, path: "sol.md" }];
		await runMerge({ run, cwd, persona, panel: "default", task: "A or B?", opinions, voices, spawn });
		assert.deepEqual(tools, [POLL_TOOLS]);
		assert.equal(run.trace.events().some(event => event.lease), false);

		tools.length = 0;
		const applied = await runMerge({ run, cwd, persona, panel: "default", task: "A or B?", opinions, voices, spawn, apply: true, command: "just flow poll --apply" });
		assert.deepEqual(tools, [MERGE_APPLY_TOOLS]);
		assert.equal(existsSync(applied.path), true);
		const acquired = run.trace.events().find(event => event.message === "writer lease acquired");
		assert.ok(acquired?.lease);
		assert.equal(acquired.ownerCommand, "just flow poll --apply");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a held writer lease fails merge with the named owner instead of waiting", async () => {
	const { cwd, run } = fixture();
	try {
		const held = acquireWriterLease({ cwd, owner: "merge:other", command: "just flow poll --apply #1" });
		try {
			await assert.rejects(runMerge({
				run, cwd, persona, panel: "default", task: "A or B?", apply: true,
				voices, opinions: [{ ok: true, voice: voices[0], report: ENVELOPE_EXAMPLES.poll as PollReport, path: "x" }],
			}), error => error instanceof WriterLeaseHeldError && /merge:other/.test(error.message) && /just flow poll --apply #1/.test(error.message));
			const traced = run.trace.events().find(event => event.type === "error" && String(event.message ?? "").includes("Writer lease held"));
			assert.ok(traced?.lease);
			assert.equal(traced.owner, "merge:other");
		} finally { releaseWriterLease(held); }
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("merge task lists every opinion so a minority cannot vanish silently", () => {
	const task = mergeTask("A or B?", [
		{ ok: true, voice: voices[0], report: { ...ENVELOPE_EXAMPLES.poll, position: "A" } as PollReport, path: "sol.md" },
		{ ok: true, voice: voices[1], report: { ...ENVELOPE_EXAMPLES.poll, position: "B" } as PollReport, path: "grok.md" },
	]);
	assert.match(task, /sol/);
	assert.match(task, /grok/);
	assert.match(task, /rejecting it requires a reason/);
});
