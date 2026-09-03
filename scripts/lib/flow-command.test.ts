import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeFlow, resolveWorkflow, workflows } from "../flow.ts";
import { parseFlowCommand, parseFlowMaintenanceCommand } from "./flow-command.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW = resolve(ROOT, "scripts", "flow.ts");
function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "flow-cli-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "ok\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd });
	return cwd;
}
function invoke(cwd: string, args: string[]) { return spawnSync(process.execPath, ["--experimental-strip-types", FLOW, ...args], { cwd, encoding: "utf8" }); }

test("flow command parsing preserves positional request and validates flags", () => {
	assert.deepEqual(Object.keys(workflows).sort(), ["build-test", "debate", "document", "poll", "quality", "scout"]);
	assert.deepEqual(parseFlowCommand(["scout", "where", "X", "--dry-run", "--allow-dirty", "--run-id", "r1"]), { name: "scout", args: ["where", "X"], dryRun: true, allowDirty: true, runId: "r1" });
	assert.deepEqual(parseFlowCommand(["poll", "--panel", "default", "should we?", "--dry-run"]), { name: "poll", args: ["should we?"], dryRun: true, allowDirty: false, panel: "default" });
	assert.deepEqual(parseFlowCommand(["debate", "--panel", "default", "--rounds", "3", "should we?", "--dry-run"]), { name: "debate", args: ["should we?"], dryRun: true, allowDirty: false, panel: "default", rounds: 3 });
	assert.deepEqual(parseFlowCommand(["poll", "--panel", "default", "--apply", "q"]), { name: "poll", args: ["q"], dryRun: false, allowDirty: false, panel: "default", apply: true });
	assert.throws(() => parseFlowCommand([]), /Usage/);
	assert.throws(() => parseFlowCommand(["bad/name"]), /Invalid flow name/);
	assert.throws(() => parseFlowCommand(["quality", "--wat"]), /Unknown flow option/);
	assert.throws(() => parseFlowCommand(["quality", "--run-id", "../x"]), /safe identifier/);
});

test("maintenance parsing keeps destructive intent explicit", () => {
	assert.deepEqual(parseFlowMaintenanceCommand(["cleanup"]), { action: "cleanup", discard: false, yes: false });
	assert.deepEqual(parseFlowMaintenanceCommand(["cleanup", "2", "--discard", "--yes"]), { action: "cleanup", selector: "2", discard: true, yes: true });
	assert.deepEqual(parseFlowMaintenanceCommand(["merge", "flow/build-test-r1", "--target", "feature/api", "--yes"]), { action: "merge", selector: "flow/build-test-r1", target: "feature/api", discard: false, yes: true });
	assert.throws(() => parseFlowMaintenanceCommand(["cleanup", "2", "--target", "main"]), /only with flow merge/);
	assert.throws(() => parseFlowMaintenanceCommand(["merge", "2", "--discard"]), /only with flow cleanup/);
	assert.throws(() => parseFlowMaintenanceCommand(["cleanup", "other"]), /full flow/);
	assert.throws(() => parseFlowMaintenanceCommand(["merge", "1", "2"]), /Only one/);
});

test("generated workflow modules are reachable through the flow dispatcher with unique entry exports", async () => {
	const cwd = repo();
	const workflowsDir = join(cwd, "scripts", "workflows");
	try {
		mkdirSync(workflowsDir, { recursive: true });
		writeFileSync(join(workflowsDir, "wf-plan-build-review.ts"), `export async function planBuildReviewWorkflow(run, input) {
			await run.phase({ name: "generated", kind: "code", owner: "test", description: "Prove generated registry reachability" }, () => undefined);
			return run.finish({ accepted: input.dryRun });
		}\n`);
		execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "generated flow fixture"], { cwd });
		const result = await executeFlow({ name: "plan-build-review", args: [], allowDirty: false, dryRun: true, runId: "generated-dry" }, { cwd, workflowsDir });
		assert.deepEqual([result.accepted, result.exitCode], [true, 0]);
		writeFileSync(join(workflowsDir, "wf-stale.ts"), "export async function copiedWorkflow() {}\n");
		await assert.rejects(resolveWorkflow("stale", workflowsDir), /must export staleWorkflow/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unknown or invalid invocation exits 2", () => {
	const cwd = repo();
	try {
		assert.equal(invoke(cwd, ["unknown"]).status, 2);
		assert.equal(invoke(cwd, ["quality", "--wat"]).status, 2);
		assert.equal(invoke(cwd, ["cleanup", "--target", "main"]).status, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("maintenance CLI lists flow branches without mutating in non-interactive mode", () => {
	const cwd = repo();
	try {
		execFileSync("git", ["branch", "flow/scout-old"], { cwd });
		const result = invoke(cwd, ["cleanup"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /1\. flow\/scout-old/);
		assert.match(execFileSync("git", ["branch", "--list", "flow/scout-old"], { cwd, encoding: "utf8" }), /flow\/scout-old/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("dirty refusal exits 3 before branch and flow-session creation", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "dirty.txt"), "x");
		const result = invoke(cwd, ["quality", "--dry-run", "--run-id", "dirty-test"]);
		assert.equal(result.status, 3, result.stderr);
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(), "main");
		assert.equal(existsSync(join(cwd, ".pi", "flow-sessions")), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("SIGTERM stops an active quality process and trace exit matches process exit", async () => {
	const cwd = repo();
	try {
		mkdirSync(join(cwd, ".ai"));
		writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), `## workflows\nquality: ${process.execPath} -e "setInterval(() => {}, 1000)"\n`);
		writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
		execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "configure hanging quality"], { cwd });
		const child = spawn(process.execPath, ["--experimental-strip-types", FLOW, "quality", "--run-id", "signal-test"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
		const trace = join(cwd, ".pi", "flow-sessions", "signal-test", "trace.jsonl");
		for (let count = 0; count < 100 && (!existsSync(trace) || !readFileSync(trace, "utf8").includes('"phase":"quality"')); count++) await new Promise(resolveWait => setTimeout(resolveWait, 20));
		assert.equal(existsSync(trace), true, "flow did not start before signal deadline");
		child.kill("SIGTERM");
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => child.once("close", (code, signal) => resolveExit({ code, signal })));
		assert.deepEqual(exit, { code: 143, signal: null });
		const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.deepEqual([events.at(-1).type, events.at(-1).exitCode, events.at(-1).signal], ["run_end", 143, "SIGTERM"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("raw node quality dry-run runs headlessly, branches, traces, and exits 0", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
		execFileSync("git", ["add", ".gitignore"], { cwd }); execFileSync("git", ["commit", "-qm", "ignore runtime"], { cwd });
		writeFileSync(join(cwd, ".env"), "FLOW_TEST_LOADED=yes\n");
		mkdirSync(join(cwd, ".ai"));
		writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "## workflows\nquality: npm test\n");
		execFileSync("git", ["add", ".ai/agent-fleet-overrides.md"], { cwd }); execFileSync("git", ["commit", "-qm", "configure quality"], { cwd });
		// .env itself is intentionally ignored so the clean-tree guard remains meaningful.
		writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n.env\n");
		execFileSync("git", ["add", ".gitignore"], { cwd }); execFileSync("git", ["commit", "-qm", "ignore env"], { cwd });
		const result = invoke(cwd, ["quality", "--dry-run", "--run-id", "raw-node"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /FLOW ACCEPTED/);
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(), "flow/quality-raw-node");
		const events = readdirSync(join(cwd, ".pi", "flow-sessions", "raw-node"));
		assert.ok(events.includes("trace.jsonl"));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("mid-run operational failures print a rejection banner consistent with trace exit 1", async () => {
	const cwd = repo();
	const original = console.error;
	const errors: string[] = [];
	workflows["failing-test"] = { run: async run => {
		await run.phase({ name: "commit", kind: "code", owner: "git", description: "Expose an operational failure after flow startup" }, () => { throw new Error("commit failed"); });
		return run.finish({ accepted: true });
	} };
	console.error = (...values: unknown[]) => { errors.push(values.join(" ")); };
	try {
		await assert.rejects(executeFlow({ name: "failing-test", args: [], allowDirty: false, dryRun: false, runId: "mid-run" }, { cwd }), /commit failed/);
		assert.ok(errors.some(line => /FLOW REJECTED \(mid-run\): commit failed/.test(line)));
		const end = readFileSync(join(cwd, ".pi", "flow-sessions", "mid-run", "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).at(-1);
		assert.deepEqual([end.status, end.exitCode], ["rejected", 1]);
	} finally {
		console.error = original;
		delete workflows["failing-test"];
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("registered build-test and document workflows complete stubbed CLI dry runs", () => {
	for (const name of ["build-test", "document"]) {
		const cwd = repo();
		try {
			mkdirSync(join(cwd, "agents")); mkdirSync(join(cwd, ".ai"));
			for (const persona of ["builder", "documenter"]) writeFileSync(join(cwd, "agents", `${persona}.md`), `---\nname: ${persona}\ndescription: stub\ntools: read\nwrites: []\nmodel: stub/model\n---\nstub`);
			writeFileSync(join(cwd, ".ai", "agent-fleet-overrides.md"), "## workflows\nquality: npm test\n"); writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
			execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "flow fixtures"], { cwd });
			const args = name === "build-test" ? [name, "implement X", "--dry-run", "--run-id", `${name}-dry`] : [name, "--dry-run", "--run-id", `${name}-dry`];
			const result = invoke(cwd, args); assert.equal(result.status, 0, `${name}: ${result.stderr}`); assert.match(result.stderr, /FLOW ACCEPTED/);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});
