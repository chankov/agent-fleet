import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpawnAgent } from "./agent-phase.ts";
import { ENVELOPE_EXAMPLES, type PollReport } from "./envelopes.ts";
import type { PersonaDefinition } from "./personas.ts";
import { POLL_PERMISSION_POLICY, POLL_TOOLS, pollVoicePath, runPoll } from "./poll.ts";
import { Run } from "./run.ts";
import type { Voice } from "./voices.ts";

const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls,write", model: "primary/model",
	models: ["fallback/model"], fallbackModel: "fallback/model", thinking: "low",
	systemPrompt: "Answer the question.", file: "agents/researcher.md", writes: ["docs/"],
};
const voices: Voice[] = [
	{ name: "sol", model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	{ name: "grok", model: "xai/grok-4.6", thinking: "medium" },
	{ name: "opus", model: "github-copilot/claude-opus-5", thinking: "medium", integrator: true },
];

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "poll-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return { cwd, run: new Run({ cwd, runId: "poll-test" }) };
}

function report(position: string): PollReport {
	return { ...ENVELOPE_EXAMPLES.poll, position, summary: position } as PollReport;
}

test("every voice receives the same task, read-only tools, and a per-voice artifact", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: Array<{ model: string; tools: string; prompt: string; sessionFile: string }> = [];
		const spawn: SpawnAgent = async options => {
			calls.push({ model: options.model, tools: options.tools, prompt: options.prompt, sessionFile: options.sessionFile });
			return { output: JSON.stringify(report(`from ${options.model}`)), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runPoll({ run, cwd, persona, panel: "default", task: "Should we use A or B?", voices, spawn });
		assert.equal(calls.length, 3);
		assert.deepEqual(calls.map(call => call.model).sort(), voices.map(voice => voice.model).sort());
		assert.ok(calls.every(call => call.tools === POLL_TOOLS));
		assert.ok(calls.every(call => call.prompt.startsWith("Should we use A or B?")));
		assert.equal(new Set(calls.map(call => call.prompt)).size, 1);
		assert.equal(new Set(calls.map(call => call.sessionFile)).size, 3);
		for (const voice of voices) {
			const path = pollVoicePath(cwd, "poll-test", voice.name);
			assert.equal(existsSync(path), true);
			assert.match(readFileSync(path, "utf8"), new RegExp(`# ${voice.name}`));
		}
		assert.equal(result.results.filter(item => item.ok).length, 3);
		assert.deepEqual(POLL_PERMISSION_POLICY, { writes: [] });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a failed voice does not fail the poll while two voices succeed", async () => {
	const { cwd, run } = fixture();
	try {
		const spawn: SpawnAgent = async options => {
			if (options.model.includes("grok")) return { output: "", exitCode: 1, stderr: "boom", toolCallsStarted: 0, modelUsed: options.model };
			return { output: JSON.stringify(report("ok")), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runPoll({ run, cwd, persona, panel: "default", task: "A or B?", voices, spawn });
		const failed = result.results.find(item => !item.ok);
		assert.ok(failed && !failed.ok);
		assert.match(failed.reason, /failed/);
		assert.match(readFileSync(failed.path, "utf8"), /status: failed/);
		assert.equal(result.results.filter(item => item.ok).length, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("fewer than two successful voices fails the poll with a named count", async () => {
	const { cwd, run } = fixture();
	try {
		const spawn: SpawnAgent = async options => {
			if (options.model.includes("sol")) return { output: JSON.stringify(report("ok")), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
			return { output: "", exitCode: 1, stderr: "nope", toolCallsStarted: 0, modelUsed: options.model };
		};
		await assert.rejects(runPoll({ run, cwd, persona, panel: "default", task: "A or B?", voices, spawn }), /1 of 3 voices succeeded/);
		assert.equal(existsSync(pollVoicePath(cwd, "poll-test", "sol")), true);
		assert.equal(existsSync(pollVoicePath(cwd, "poll-test", "grok")), true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
