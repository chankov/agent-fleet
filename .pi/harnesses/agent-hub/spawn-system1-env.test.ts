import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDispatchComs } from "./dispatch-coms.ts";
import { nativeChildEnv, spawnPiAgent, spawnPiAgentWithModelFallback } from "./spawn.ts";
import { linuxUserNamespaceSandboxAvailable } from "./write-isolation.ts";

const STRIPPED = "TYPESAFE_API_KEY";
const OTHER = "AF_OTHER_CREDENTIAL";
const EXTRA = "AF_UNRELATED_PROVIDER_KEY";

function restoreEnv(previous: NodeJS.ProcessEnv): void {
	for (const key of [STRIPPED, OTHER, EXTRA]) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
}

function writeFakePi(dir: string, mode = "env"): void {
	const script = `#!/usr/bin/env node
const fs = require('node:fs');
const report = process.env.ENV_REPORT;
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : '';
const line = JSON.stringify({
  typesafeAbsent: process.env.${STRIPPED} == null,
  otherPresent: process.env.${OTHER} != null,
  extraPresent: process.env.${EXTRA} != null,
  model,
});
if (report) fs.writeFileSync(report, line);
if (process.env.ENV_REPORT_LOG) fs.appendFileSync(process.env.ENV_REPORT_LOG, line + '\\n');
if (process.env.FAKE_PI_MODE === 'fallback' && model === 'fake/override') {
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable' } }) + '\\n');
  process.exit(1);
}
if (process.env.FAKE_PI_MODE === 'corrupt') {
  process.stderr.write('not a valid pi session\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'VERDICT: ON_TRACK — serving' } }) + '\\n');
process.exit(0);
`;
	writeFileSync(join(dir, "pi"), script, { mode: 0o755 });
	chmodSync(join(dir, "pi"), 0o755);
	void mode;
}

async function launch(dir: string, opts: Record<string, unknown>) {
	const report = join(dir, `report-${Math.random().toString(16).slice(2)}.json`);
	const result = await spawnPiAgent({
		model: "fake/model",
		tools: "read",
		thinking: "off",
		appendSystemPrompt: "judge",
		sessionFile: join(dir, "session.json"),
		prompt: "probe",
		cwd: dir,
		activeProfileSnapshot: undefined,
		...opts,
		env: { PATH: `${dir}:${process.env.PATH ?? ""}`, ENV_REPORT: report, ...(opts.env as Record<string, string> | undefined) },
	});
	const body = JSON.parse(readFileSync(report, "utf8"));
	rmSync(report, { force: true });
	return { result, body };
}

test("A4 final merged env drops only TYPESAFE_API_KEY and does not mutate the parent", async () => {
	const previous = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), "s1-env-"));
	process.env[STRIPPED] = "parent-sentinel";
	process.env[OTHER] = "keep-other";
	process.env[EXTRA] = "keep-extra";
	try {
		writeFakePi(dir);
		const merged = nativeChildEnv(process.env, { [STRIPPED]: "override-sentinel", [OTHER]: "keep-other" });
		assert.equal(Object.prototype.hasOwnProperty.call(merged, STRIPPED), false);
		assert.equal(merged[OTHER] === process.env[OTHER], true);
		assert.equal(process.env[STRIPPED] === "parent-sentinel", true);
		const normal = await launch(dir, { env: { [STRIPPED]: "override-sentinel" } });
		assert.equal(normal.result.exitCode, 0);
		assert.equal(normal.body.typesafeAbsent, true);
		assert.equal(normal.body.otherPresent, true);
		assert.equal(normal.body.extraPresent, true);
		assert.equal(process.env[STRIPPED] === "parent-sentinel", true);
		assert.equal(process.env[EXTRA] === "keep-extra", true);
	} finally {
		restoreEnv(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("MI-9 published write isolation does not carry the merged child env", async () => {
	const previous = process.env[STRIPPED];
	process.env[STRIPPED] = "parent-sentinel";
	const dir = mkdtempSync(join(tmpdir(), "s1-isolation-env-"));
	try {
		const result = await spawnPiAgent({
			model: "fake/model",
			tools: "read",
			thinking: "off",
			appendSystemPrompt: "",
			sessionFile: join(dir, "session.json"),
			prompt: "probe",
			cwd: dir,
			activeProfileSnapshot: undefined,
			writeIsolation: { enabled: false, cwd: dir },
			env: { [STRIPPED]: "override-sentinel", [OTHER]: "keep-other" },
		});
		const published = result.writeIsolation as { env?: unknown } | undefined;
		assert.equal(result.toolCallsStarted, 0);
		assert.equal(published == null || Object.prototype.hasOwnProperty.call(published, "env"), false);
		assert.equal(JSON.stringify(published ?? {}).includes("sentinel"), false);
		assert.equal(process.env[STRIPPED] === "parent-sentinel", true);
	} finally {
		if (previous === undefined) delete process.env[STRIPPED];
		else process.env[STRIPPED] = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("A4 judge, fallback and retry launches cannot reinject the stripped key", async () => {
	const previous = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), "s1-env-matrix-"));
	process.env[STRIPPED] = "parent-sentinel";
	process.env[OTHER] = "keep-other";
	try {
		writeFakePi(dir);
		const report = join(dir, "judge-report.json");
		const coms = createDispatchComs({
			getSessionDir: () => dir,
			getWatchdogJudgeModel: () => "fake/judge",
			getResearcherModel: () => null,
			safePathWithin: (root: string, name: string) => join(root, name),
			spawnPiAgent: (opts: any) => spawnPiAgent({ ...opts, activeProfileSnapshot: undefined, cwd: dir, env: { ...opts.env, PATH: `${dir}:${process.env.PATH ?? ""}`, ENV_REPORT: report, [STRIPPED]: "judge-override" } }),
		} as any);
		const judged = await coms.runDriftJudge({
			agentLabel: "Builder", agentKey: "builder", task: "t", scopeGlobs: [], hubOwnedGlobs: [], trail: [],
			violation: { rule: "loop", detail: "x" }, sessionKey: "judge-attempt-1",
		}, {} as any);
		assert.equal(judged.status, "verdict");
		assert.equal(JSON.parse(readFileSync(report, "utf8")).typesafeAbsent, true);
		rmSync(report, { force: true });

		const log = join(dir, "launches.jsonl");
		const fallback = await spawnPiAgentWithModelFallback({
			model: "fake/override",
			tools: "read",
			thinking: "off",
			appendSystemPrompt: "x",
			sessionFile: join(dir, "fallback-session.json"),
			prompt: "probe",
			cwd: dir,
			activeProfileSnapshot: undefined,
			env: { PATH: `${dir}:${process.env.PATH ?? ""}`, FAKE_PI_MODE: "fallback", ENV_REPORT_LOG: log, [STRIPPED]: "fallback-override", [OTHER]: "keep-other" },
		}, "fake/persona");
		assert.equal(fallback.modelFallback?.to, "fake/persona");
		const launches = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(launches.length, 2);
		assert.equal(launches.every((line: { typesafeAbsent: boolean; otherPresent: boolean }) => line.typesafeAbsent && line.otherPresent), true);
		const directRetry = await launch(dir, { env: { [STRIPPED]: "retry-override" } });
		assert.equal(directRetry.body.typesafeAbsent, true);
		assert.equal(directRetry.body.otherPresent, true);
		assert.equal(process.env[STRIPPED] === "parent-sentinel", true);
	} finally {
		restoreEnv(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("A4 real local child sees the filtered env and logs only booleans", async () => {
	const previous = process.env[STRIPPED];
	process.env[STRIPPED] = "local-probe-sentinel";
	process.env[OTHER] = "local-other";
	const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({typesafeAbsent:process.env.TYPESAFE_API_KEY==null,otherPresent:process.env.AF_OTHER_CREDENTIAL!=null}))"], {
		env: nativeChildEnv(process.env, { [STRIPPED]: "reinjected" }),
		stdio: ["ignore", "pipe", "ignore"],
	});
	const chunks: Buffer[] = [];
	child.stdout.on("data", (chunk) => chunks.push(chunk));
	const code = await new Promise<number | null>(resolve => child.once("close", resolve));
	const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	assert.equal(code, 0);
	assert.equal(report.typesafeAbsent, true);
	assert.equal(report.otherPresent, true);
	assert.equal(process.env[STRIPPED] === "local-probe-sentinel", true);
	if (previous === undefined) delete process.env[STRIPPED];
	else process.env[STRIPPED] = previous;
	delete process.env[OTHER];
});

test("A4 sandbox launch coverage", { skip: !linuxUserNamespaceSandboxAvailable() }, async () => {
	const previous = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), "s1-env-sandbox-"));
	process.env[STRIPPED] = "sandbox-sentinel";
	process.env[OTHER] = "keep-other";
	try {
		writeFakePi(dir);
		for (const name of ["allowed-dir", "runtime", "artifacts", "temp"]) mkdirSync(join(dir, name));
		const report = join(dir, "allowed-dir", "env-report.json");
		const result = await spawnPiAgent({
			model: "fake/model", tools: "read", thinking: "off", appendSystemPrompt: "x",
			sessionFile: join(dir, "runtime", "session.json"), prompt: "probe", cwd: dir, detached: true, activeProfileSnapshot: undefined,
			env: { PATH: `${dir}:${process.env.PATH ?? ""}`, ENV_REPORT: report, TMPDIR: join(dir, "temp"), [STRIPPED]: "sandbox-override", [OTHER]: "keep-other" },
			writeIsolation: { enabled: true, cwd: dir, allowlist: ["allowed-dir/"], runtimePaths: [join(dir, "runtime")], artifactPaths: [join(dir, "artifacts")], tempPaths: [join(dir, "temp")] },
		});
		assert.equal(result.writeIsolation?.applied, true);
		assert.equal(result.exitCode === 0, true);
		assert.equal(JSON.parse(readFileSync(report, "utf8")).typesafeAbsent, true);
		assert.equal(process.env[STRIPPED] === "sandbox-sentinel", true);
	} finally {
		restoreEnv(previous);
		rmSync(dir, { recursive: true, force: true });
	}
});
