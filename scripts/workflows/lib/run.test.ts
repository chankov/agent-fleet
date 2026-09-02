import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Run, validateDescription } from "./run.ts";

function fixture() { const cwd = mkdtempSync(join(tmpdir(), "flow-run-")); return { cwd, run: new Run({ cwd, runId: "test-run" }) }; }

test("phase starts failed and earns success only after a clean body", async () => {
	const { cwd, run } = fixture();
	try {
		await run.phase({ name: "quality", kind: "code", owner: "quality", description: "Execute deterministic acceptance evidence" }, phase => {
			assert.equal(phase.status, "fail");
		});
		const events = run.trace.events();
		assert.equal(events.find(e => e.type === "phase_start")?.status, "fail");
		assert.equal(events.find(e => e.type === "phase_end")?.status, "success");
		run.finish({ accepted: true });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("thrown phase finalizes failed and propagates the original error", async () => {
	const { cwd, run } = fixture();
	try {
		const boom = new Error("boom");
		await assert.rejects(run.phase({ name: "build", kind: "agent", owner: "builder", description: "Produce the requested implementation" }, () => { throw boom; }), error => error === boom);
		const events = run.trace.events();
		assert.equal(events.find(e => e.type === "phase_end")?.status, "fail");
		assert.deepEqual(events.filter(e => e.type === "run_end").map(e => [e.status, e.exitCode]), [["rejected", 1]]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("phase retries are bounded before the run is finalized", async () => {
	const { cwd, run } = fixture();
	try {
		let attempts = 0;
		const value = await run.phase({ name: "review", kind: "agent", owner: "reviewer", description: "Correct a rejected report in the same bounded phase", retries: 2 }, () => {
			attempts++;
			if (attempts < 3) throw new Error(`attempt ${attempts}`);
			return "clean";
		});
		assert.equal(value, "clean");
		assert.equal(attempts, 3);
		assert.equal(run.trace.events().filter(event => event.type === "phase_end").length, 1);
		assert.equal(run.finish({ accepted: true }).exitCode, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("signal interruption aborts children and records the exact process exit code", () => {
	const { cwd, run } = fixture();
	try {
		const result = run.interrupt("SIGTERM");
		assert.equal(run.signal.aborted, true);
		assert.equal(result.exitCode, 143);
		assert.deepEqual([run.trace.events().at(-1)?.exitCode, run.trace.events().at(-1)?.signal], [143, "SIGTERM"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("SIGINT interruption records exit 130 and matching trace signal", () => {
	const { cwd, run } = fixture();
	try {
		const result = run.interrupt("SIGINT");
		assert.equal(run.signal.aborted, true);
		assert.equal(result.exitCode, 130);
		assert.deepEqual([run.trace.events().at(-1)?.exitCode, run.trace.events().at(-1)?.signal], [130, "SIGINT"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("finish synchronizes acceptance, exit, trace and banner and is single-use", () => {
	const { cwd, run } = fixture();
	try {
		const result = run.finish({ accepted: false, reason: "review was not clean" });
		assert.deepEqual([result.accepted, result.status, result.exitCode], [false, "rejected", 1]);
		assert.match(result.banner, /FLOW REJECTED.*review was not clean/);
		assert.equal(run.trace.events().at(-1)?.banner, result.banner);
		assert.throws(() => run.finish({ accepted: true }), /exactly once/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("phase success remains distinct from rejected acceptance", async () => {
	const { cwd, run } = fixture();
	try {
		await run.phase({ name: "suite", kind: "code", owner: "quality", description: "Capture a real red suite as evidence" }, () => ({ passed: false }));
		const result = run.finish({ accepted: false, reason: "suite red" });
		assert.equal(run.trace.events().find(e => e.type === "phase_end")?.status, "success");
		assert.equal(result.accepted, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("empty and name-repeating descriptions are refused", () => {
	assert.throws(() => validateDescription("commit_plan", ""), /explain why/);
	assert.throws(() => validateDescription("commit_plan", "Commit the plan"), /merely repeat/);
	assert.doesNotThrow(() => validateDescription("commit_plan", "Persist the reviewed plan for the builder"));
});
