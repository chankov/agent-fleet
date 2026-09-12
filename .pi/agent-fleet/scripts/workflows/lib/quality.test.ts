import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asEnvelope, executeQuality, qualityCommand } from "./quality.ts";

test("quality command reads the final workflows section and never substitutes npm test", () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-quality-config-"));
	try {
		mkdirSync(join(cwd, ".ai"));
		writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "# Overrides\n\n## workflows\nquality: node --test 'focused test.ts'\n");
		assert.deepEqual(qualityCommand(cwd), ["node", "--test", "focused test.ts"]);
		writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "## workflows\nother: npm test\n");
		assert.throws(() => qualityCommand(cwd), (error: any) => error.exitCode === 3 && /configure.*quality/i.test(error.message));
		rmSync(join(cwd, ".ai", "agent-fleet-overrides.md"));
		assert.throws(() => qualityCommand(cwd), (error: any) => error.exitCode === 3 && !/npm test.*fallback/i.test(error.message));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("quality executes argv without a shell and persists real evidence", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-quality-"));
	try {
		const logPath = join(cwd, "command.log");
		const result = await executeQuality([process.execPath, "-e", "console.log('green')"], { cwd, logPath });
		assert.equal(result.passed, true);
		assert.match(readFileSync(logPath, "utf8"), /green[\s\S]*exit 0/);
		assert.equal(asEnvelope(result, "suite").status, "success");
		assert.deepEqual(asEnvelope(result, "suite").artifacts, [logPath]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("red quality command is evidence, not a thrown phase", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-quality-red-"));
	try {
		const result = await executeQuality([process.execPath, "-e", "console.error('red'); process.exit(7)"], { cwd, logPath: join(cwd, "command.log") });
		assert.equal(result.exitCode, 7);
		assert.equal(result.passed, false);
		assert.equal(asEnvelope(result, "suite").status, "fail");
		assert.match(asEnvelope(result, "suite").notes_for_next_agent, /red/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("quality inherits operator env, never invokes a shell, and maps missing binary to 127", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-quality-runtime-"));
	try {
		process.env.FLOW_OPERATOR_VALUE = "inherited";
		const envResult = await executeQuality([process.execPath, "-e", "process.stdout.write(process.env.FLOW_OPERATOR_VALUE || '')", ";touch", "pwned"], { cwd, logPath: join(cwd, "env.log") });
		assert.equal(envResult.stdout, "inherited");
		assert.equal(existsSync(join(cwd, "pwned")), false, "argv metacharacters must not be interpreted by a shell");
		const missing = await executeQuality(["definitely-no-such-flow-binary"], { cwd, logPath: join(cwd, "missing.log") });
		assert.equal(missing.exitCode, 127); assert.match(missing.stderr, /ENOENT|spawn definitely-no-such-flow-binary/);
	} finally { delete process.env.FLOW_OPERATOR_VALUE; rmSync(cwd, { recursive: true, force: true }); }
});

test("quality timeout and AbortSignal terminate commands with evidence", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-quality-stop-"));
	try {
		const timed = await executeQuality([process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd, logPath: join(cwd, "timeout.log"), timeoutSeconds: 0.02 });
		assert.equal(timed.passed, false); assert.match(timed.stderr, /Timed out/);
		const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
		const aborted = await executeQuality([process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd, logPath: join(cwd, "abort.log"), signal: controller.signal });
		assert.equal(aborted.passed, false); assert.match(aborted.stderr, /Cancelled by flow signal/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
