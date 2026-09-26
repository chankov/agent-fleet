import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { confineNativeChild, linuxUserNamespaceSandboxAvailable } from "../../../../../.pi/harnesses/agent-hub/write-isolation.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { SpawnPiAgentOptions } from "../../../../../.pi/harnesses/agent-hub/spawn.ts";
import { modelTag, phaseSessionKey, runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import { ENVELOPE_EXAMPLES } from "./envelopes.ts";
import { GateReport } from "./gates.ts";
import type { PersonaDefinition } from "./personas.ts";
import { Run } from "./run.ts";
import { createProjectPolicyFixture, FIXTURE_POLICY_MARKER } from "../../../../../bin/test/helpers/project-policy-fixture.js";

const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls", model: "primary/model", models: ["fallback/model"], fallbackModel: "fallback/model",
	thinking: "low", systemPrompt: "Use skills/incremental-implementation/SKILL.md", file: "agents/researcher.md", writes: [],
};
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "flow-agent-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return { cwd, run: new Run({ cwd, runId: "agent-test" }) };
}

test("agent phase uses replacement context, fallback, detached safety, and same-session correction", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: Array<{ options: SpawnPiAgentOptions; fallback?: string }> = [];
		const spawn: SpawnAgent = async (options, fallback, callbacks) => {
			calls.push({ options, fallback });
			callbacks?.onProcess?.({ pid: 4321 } as ChildProcess);
			mkdirSync(dirname(options.sessionFile), { recursive: true }); writeFileSync(options.sessionFile, "session");
			callbacks?.onUsage?.({ input: 100, output: 20 }, "agent_end");
			return { output: calls.length === 1 ? JSON.stringify({ status: "success", summary: "missing findings" }) : JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn });
		assert.deepEqual(result, ENVELOPE_EXAMPLES.scout);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].options.resume, false);
		assert.equal(calls[1].options.resume, true);
		assert.equal(calls[0].fallback, "fallback/model");
		assert.equal(calls[0].options.detached, true);
		assert.equal(calls[0].options.signal, run.signal);
		assert.equal(run.trace.events().find(event => event.type === "agent_process")?.pid, 4321);
		assert.equal(run.trace.events().find(event => event.type === "agent_process")?.processGroup, -4321);
		assert.equal(calls[0].options.turnDeadlineMs, 1_200_000);
		assert.deepEqual(calls[0].options.toolWatchdog, { timeoutMs: 120_000 });
		assert.deepEqual(calls[0].options.extensions, [".pi/harnesses/damage-control-continue/index.ts"]);
		assert.ok(calls[0].options.systemPrompt?.startsWith("# Managed Specialist"));
		assert.equal(calls[0].options.appendSystemPrompt, undefined);
		assert.match(calls[1].options.prompt, /findings/);
		const invalidAttempts = run.trace.events().filter(event => event.invalidEnvelope === true);
		assert.equal(invalidAttempts.length, 1);
		assert.deepEqual(invalidAttempts[0].attempt, 1);
		assert.ok((invalidAttempts[0].errors as string[]).some(error => error.includes("findings")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("workflow phase with omitted policy options resolves configured rules before production spawn", async () => {
	const project = createProjectPolicyFixture("workflow-policy-");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project.cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: project.cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: project.cwd });
	execFileSync("git", ["add", "."], { cwd: project.cwd }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project.cwd });
	const run = new Run({ cwd: project.cwd, runId: "policy-test" });
	try {
		let systemPrompt = "";
		const spawn: SpawnAgent = async options => {
			systemPrompt = options.systemPrompt ?? "";
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		assert.equal(project.task.includes(FIXTURE_POLICY_MARKER), false, "fixture policy is absent from the user task");
		await runAgentPhase({ run, persona, task: project.task, envelope: "scout", cwd: project.cwd, spawn });
		assert.match(systemPrompt, /Applicable project rules: \.ai\/rules/);
		assert.match(systemPrompt, /index-first/);
		assert.doesNotMatch(systemPrompt, /reference-only|UNRELATED_ARCHIVE_SENTINEL/);
	} finally { project.cleanup(); }
});

test("scout/build-test/document/poll/debate/merge production phase sends configured policy in system prompt", async () => {
	const project = createProjectPolicyFixture("workflow-six-prompts-");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project.cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: project.cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: project.cwd });
	execFileSync("git", ["add", "."], { cwd: project.cwd });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project.cwd });
	const run = new Run({ cwd: project.cwd, runId: "six-policy-prompts" });
	try {
		for (const envelope of ["scout", "build", "document", "poll", "debate", "merge"] as const) {
			let sent = "";
			await runAgentPhase({ run, persona, task: project.task, envelope, cwd: project.cwd, spawn: async options => {
				sent = options.systemPrompt ?? "";
				return { output: JSON.stringify(ENVELOPE_EXAMPLES[envelope]), exitCode: 0 };
			} });
			assert.match(sent, /Applicable project rules: \.ai\/rules/, envelope);
			assert.match(sent, /index-first/, envelope);
			assert.doesNotMatch(sent, /UNRELATED_ARCHIVE_SENTINEL/, envelope);
		}
	} finally { project.cleanup(); }
});

test("T13 Hub scout phase uses real native OS confinement and session-owned support writes", { skip: !linuxUserNamespaceSandboxAvailable() }, async () => {
	const { cwd, run } = fixture(); const tools = mkdtempSync(join(tmpdir(), "flow-fake-pi-")); const outside = mkdtempSync(join(tmpdir(), "flow-original-"));
	const victim = join(outside, ".env"), fakePi = join(tools, "pi"); const oldPath = process.env.PATH; const oldVictim = process.env.T13_ORIGINAL_VICTIM;
	try {
		writeFileSync(victim, "original-secret\n");
		writeFileSync(fakePi, `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); const session=args[args.indexOf('--session')+1]; fs.writeFileSync(session,'owned-session'); try { fs.writeFileSync(process.env.T13_ORIGINAL_VICTIM,'pwned'); } catch {} const report=${JSON.stringify(JSON.stringify(ENVELOPE_EXAMPLES.scout))}; process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:report}})+'\\n');`, { mode: 0o755 });
		process.env.PATH = `${tools}:${oldPath}`; process.env.T13_ORIGINAL_VICTIM = victim;
		const result = await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, dataReadRoot: cwd });
		assert.deepEqual(result, ENVELOPE_EXAMPLES.scout); assert.equal(readFileSync(victim, "utf8"), "original-secret\n");
		assert.equal(readFileSync(join(run.trace.directory, "researcher", "session.json"), "utf8"), "owned-session");
	} finally {
		if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		if (oldVictim === undefined) delete process.env.T13_ORIGINAL_VICTIM; else process.env.T13_ORIGINAL_VICTIM = oldVictim;
		rmSync(cwd, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
	}
});

test("scout starts real Pi under confinement and removes private runtime state", { skip: !linuxUserNamespaceSandboxAvailable() }, async () => {
	const { cwd, run } = fixture();
	const source = mkdtempSync(join(tmpdir(), "flow-pi-source-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	let runtime: string | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = source;
		writeFileSync(join(source, "auth.json"), "{}");
		writeFileSync(join(source, "trust.json"), "{}");
		writeFileSync(join(source, "settings.json"), JSON.stringify({ packages: ["npm:scout-must-not-install-this-package"], extensions: ["./missing-extension.ts"], skills: ["./missing-skills"], prompts: ["./missing-prompts"], themes: ["./missing-themes"], transport: "sse", defaultProjectTrust: "never" }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
		const spawn: SpawnAgent = async options => {
			assert.ok(options.extensions?.every(path => path.startsWith("/")), "scout extensions resolve from the installed runtime, not the dependency-free snapshot");
			const launch = confineNativeChild({ ...options.writeIsolation!, command: "pi", args: ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", ...(options.extensions ?? []).flatMap(path => ["-e", path]), "--session", options.sessionFile], env: options.env });
			assert.equal(launch.applied, true);
			const child = spawnSync(launch.command!, launch.args!, { cwd, env: { ...process.env, ...options.env }, input: '{"id":"probe","type":"get_state"}\n', encoding: "utf8", timeout: 20000 });
			assert.equal(child.status, 0, child.stderr || String(child.error));
			assert.match(child.stdout, /"command":"get_state","success":true/);
			runtime = options.env?.PI_CODING_AGENT_DIR;
			assert.ok(runtime && runtime !== source);
			const settings = JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8"));
			assert.equal(settings.transport, "sse");
			assert.equal(settings.defaultProjectTrust, "never");
			for (const key of ["packages", "extensions", "skills", "prompts", "themes"]) assert.deepEqual(settings[key], []);
			assert.equal(statSync(runtime).mode & 0o777, 0o700);
			assert.equal(statSync(join(runtime, "auth.json")).mode & 0o777, 0o600);
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0 };
		};
		await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, dataReadRoot: cwd, spawn });
		assert.equal(existsSync(runtime!), false);
		assert.equal(readFileSync(join(source, "auth.json"), "utf8"), "{}");
		assert.equal(readFileSync(join(source, "trust.json"), "utf8"), "{}");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(source, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
	}
});

test("scout removes copied credentials when spawning throws", async () => {
	const { cwd, run } = fixture();
	const source = mkdtempSync(join(tmpdir(), "flow-pi-source-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	let runtime: string | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = source;
		writeFileSync(join(source, "auth.json"), '{"test":"synthetic"}');
		writeFileSync(join(source, "models.json"), '{}');
		const spawn: SpawnAgent = async options => {
			runtime = options.env?.PI_CODING_AGENT_DIR;
			assert.ok(runtime);
			assert.equal(readFileSync(join(runtime, "auth.json"), "utf8"), '{"test":"synthetic"}');
			assert.equal(readFileSync(join(runtime, "models.json"), "utf8"), '{}');
			assert.equal(existsSync(join(runtime, "trust.json")), false);
			throw new Error("spawn failed");
		};
		await assert.rejects(runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, dataReadRoot: cwd, spawn }), /spawn failed/);
		assert.equal(existsSync(runtime!), false);
		assert.equal(readFileSync(join(source, "auth.json"), "utf8"), '{"test":"synthetic"}');
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(source, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent-declared fail rejects the containing run without correction", async () => {
	const { cwd, run } = fixture();
	try {
		let calls = 0;
		const spawn: SpawnAgent = async options => {
			calls++;
			return { output: JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, status: "fail", summary: "blocked" }), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await assert.rejects(run.phase({ name: "scout", kind: "agent", owner: "researcher", description: "Reject reconnaissance that reports its own failure", retries: 2 }, () => runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn })), /agent declared fail/);
		assert.equal(calls, 1);
		const end = run.trace.events().find(event => event.type === "run_end");
		assert.deepEqual([end?.accepted, end?.exitCode], [false, 1]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("context-window pressure recycles persisted session before spawn", async () => {
	const { cwd, run } = fixture();
	try {
		const dir = join(run.trace.directory, "researcher"); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.json"), "old");
		writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ contextTokens: 950 }));
		let seenResume: boolean | undefined;
		const spawn: SpawnAgent = async options => {
			seenResume = options.resume;
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await runAgentPhase({ run, persona, task: "A".repeat(500), envelope: "scout", cwd, spawn, contextWindow: 1000 });
		assert.equal(seenResume, false);
		assert.ok(run.trace.events().some(event => String(event.message).includes("session recycled before spawn")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("failed executable gate corrects in the same bounded session", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: SpawnPiAgentOptions[] = []; let gateCalls = 0;
		const spawn: SpawnAgent = async options => { calls.push(options); mkdirSync(dirname(options.sessionFile), { recursive: true }); writeFileSync(options.sessionFile, "session"); return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		const report = await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn, gateRetries: 1, gates: [() => new GateReport("stub").check("item", ++gateCalls > 1, "RED GATE EVIDENCE")] });
		assert.deepEqual(report, ENVELOPE_EXAMPLES.scout); assert.equal(calls.length, 2); assert.equal(calls[1].resume, true); assert.match(calls[1].prompt, /RED GATE EVIDENCE/);
		assert.equal(run.trace.events().filter(event => event.type === "gate_report").length, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("agent phase refuses a missing writes policy before spawning", async () => {
	const { cwd, run } = fixture();
	try {
		let calls = 0;
		const spawn: SpawnAgent = async options => { calls++; return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		await assert.rejects(runAgentPhase({ run, persona: { ...persona, writes: undefined }, task: "Locate X", envelope: "scout", cwd, spawn }), /has no writes policy/);
		assert.equal(calls, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("model tag is path-safe", () => {
	assert.equal(modelTag("openai-codex/gpt-6-sol"), "openai-codex-gpt-6-sol");
	assert.equal(modelTag("github-copilot/claude-opus-5"), "github-copilot-claude-opus-5");
	assert.equal(modelTag("a b/c*"), "a-b-c-");
	assert.equal(phaseSessionKey("researcher"), "researcher");
	assert.equal(phaseSessionKey("researcher", "openai-codex/gpt-6-sol"), "researcher-openai-codex-gpt-6-sol");
	assert.equal(phaseSessionKey("researcher", "openai-codex/gpt-6-sol", "merge"), "researcher-openai-codex-gpt-6-sol-merge");
});

test("two phases of one persona with different models get different session directories", async () => {
	const { cwd, run } = fixture();
	try {
		const sessions: string[] = [];
		const spawn: SpawnAgent = async options => {
			sessions.push(options.sessionFile);
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn, model: "openai-codex/gpt-6-sol" });
		await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn, model: "xai/grok-4.7" });
		assert.equal(sessions.length, 2);
		assert.notEqual(dirname(sessions[0]), dirname(sessions[1]));
		assert.match(sessions[0], /researcher-openai-codex-gpt-6-sol/);
		assert.match(sessions[1], /researcher-xai-grok-4\.7/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a phase without a model override keeps the persona model and today's session directory", async () => {
	const { cwd, run } = fixture();
	try {
		let seen: { model?: string; thinking?: string; sessionFile?: string; fallback?: string } = {};
		const spawn: SpawnAgent = async (options, fallback) => {
			seen = { model: options.model, thinking: options.thinking, sessionFile: options.sessionFile, fallback };
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn });
		assert.equal(seen.model, "primary/model");
		assert.equal(seen.thinking, "low");
		assert.equal(seen.fallback, "fallback/model");
		assert.equal(dirname(seen.sessionFile!), join(run.trace.directory, "researcher"));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a model override still uses the persona fallback model", async () => {
	const { cwd, run } = fixture();
	try {
		let seen: { model?: string; thinking?: string; fallback?: string } = {};
		const spawn: SpawnAgent = async (options, fallback) => {
			seen = { model: options.model, thinking: options.thinking, fallback };
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn, model: "xai/grok-4.7", thinking: "medium" });
		assert.equal(seen.model, "xai/grok-4.7");
		assert.equal(seen.thinking, "medium");
		assert.equal(seen.fallback, "fallback/model");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("PermissionBreach rolls back and terminates without correction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-agent-permission-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(join(cwd, "base.txt"), "base"); writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n"); execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "base"], { cwd });
		const run = new Run({ cwd, runId: "breach" }); let calls = 0;
		const restricted = { ...persona, writes: [] };
		const spawn: SpawnAgent = async options => { calls++; writeFileSync(join(cwd, "forbidden.txt"), "bad"); return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		await assert.rejects(run.phase({ name: "restricted", kind: "agent", owner: "researcher", description: "Enforce repository writes without retrying a breach", retries: 2 }, () => runAgentPhase({ run, persona: restricted, task: "Locate X", envelope: "scout", cwd, spawn, gateRetries: 2 })), /PermissionBreach/);
		assert.equal(calls, 1); assert.equal(existsSync(join(cwd, "forbidden.txt")), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('workflow phase and inline panel obey inherited local profile without cloud fallback',async()=>{
 const runtimePath:string='../../../../../.pi/harnesses/agent-hub/policy/profile-runtime.ts';
 const {PROFILE_ENV,setActiveProfile}=await import(runtimePath);
 const {resolvePersona}=await import('./personas.ts');const {resolvePanel,listPanelNames}=await import('./voices.ts');
 const {cwd,run}=fixture();const previous=process.env[PROFILE_ENV];
 mkdirSync(join(cwd,'agents'));writeFileSync(join(cwd,'agents','researcher.md'),'---\nname: researcher\nmodel: cloud/base\ntools: read\nthinking: high\nwrites: []\n---\nRead files.\n');
 setActiveProfile({name:'local',profile:{version:2,defaults:{model:'omlx/laguna',thinking:'off'},fallback:'none',routing:'native','allowed-models':['omlx/laguna','omlx/qwen'],panel:[{name:'laguna',model:'omlx/laguna',integrator:true},{name:'qwen',model:'omlx/qwen'}]}});
 try {
  const selected=resolvePersona('researcher',cwd);assert.equal(selected.model,'omlx/laguna');assert.equal(selected.thinking,'off');assert.equal(selected.fallbackModel,undefined);
  assert.deepEqual(listPanelNames(cwd),['local']);assert.equal(resolvePanel('local',cwd)[1].model,'omlx/qwen');assert.throws(()=>resolvePanel('default',cwd),/owns/);
  let calls=0;const spawn:SpawnAgent=async(opts,fallback)=>{calls++;assert.equal(opts.model,'omlx/qwen');assert.equal(opts.thinking,'off');assert.equal(fallback,undefined);return {output:JSON.stringify(ENVELOPE_EXAMPLES.scout),exitCode:0};};
  await runAgentPhase({run,cwd,persona:selected,model:'omlx/qwen',task:'Read',envelope:'scout',spawn});assert.equal(calls,1);
  await assert.rejects(runAgentPhase({run,cwd,persona:selected,model:'cloud/base',task:'Read',envelope:'scout',spawn}),/refuses/);assert.equal(calls,1);
 }finally{if(previous===undefined)delete process.env[PROFILE_ENV];else process.env[PROFILE_ENV]=previous;rmSync(cwd,{recursive:true,force:true});}
});
