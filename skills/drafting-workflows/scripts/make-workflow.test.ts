import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { makeWorkflow, parsePhaseList, readWorkflowShapes, renameWorkflowSymbols, replacePhaseDocstring, selectNearestWorkflow, type CommandRunner } from "./make-workflow.ts";

function fixture(): { cwd: string; workflows: string } {
	const cwd = mkdtempSync(resolve(tmpdir(), "make-workflow-"));
	const workflows = resolve(cwd, "scripts/workflows");
	mkdirSync(workflows, { recursive: true });
	writeFileSync(resolve(workflows, "tsconfig.json"), "{}\n");
	const files: Record<string, string> = {
		"wf-alpha.ts": "const identity = 'alpha';\n/** Phases: engineer(request) → agent(builder) */\nexport async function alphaWorkflow() { return identity; }\n",
		"wf-beta.ts": "const identity = 'beta';\n/** Phases: code(changes) → agent(documenter) → code(commit) */\nexport async function betaWorkflow() { return identity; }\n",
		"wf-gamma.ts": "const identity = 'gamma';\n/** Phases: engineer(request) → agent(builder) → code(test) → agent(fix) → code(commit) */\nexport async function gammaWorkflow() { return identity; }\n",
	};
	for (const [name, source] of Object.entries(files)) writeFileSync(resolve(workflows, name), source);
	return { cwd, workflows };
}

const greenRunner: CommandRunner = () => ({ status: 0 });

test("nearest shape selection is deterministic and copies the complete source", () => {
	const { cwd, workflows } = fixture();
	const phases = parsePhaseList("code(plan) → agent(build) → code(review)");
	const selected = selectNearestWorkflow(readWorkflowShapes(workflows), phases);
	assert.equal(selected.name, "beta");
	const result = makeWorkflow({ cwd, workflowsDir: workflows, name: "plan-build-review", phases, runner: greenRunner });
	const generated = readFileSync(result.outputPath, "utf8");
	assert.equal(result.sourcePath, selected.path);
	assert.equal(generated, replacePhaseDocstring(renameWorkflowSymbols(selected.source, selected.name, "plan-build-review"), phases));
	assert.match(generated, /const identity = 'beta'/);
	assert.match(generated, /export async function planBuildReviewWorkflow/);
	assert.doesNotMatch(generated, /export async function betaWorkflow/);
	assert.doesNotMatch(generated, /TODO:.*(?:import|export|boilerplate)/i);
});

test("phase parsing preserves commas inside parentheses and selects the true nearest shape", () => {
	const { workflows } = fixture();
	const phases = parsePhaseList("engineer(request), agent(builder), code(test), agent(builder-fix, bounded), code(commit)");
	assert.deepEqual(phases, ["engineer(request)", "agent(builder)", "code(test)", "agent(builder-fix, bounded)", "code(commit)"]);
	assert.equal(selectNearestWorkflow(readWorkflowShapes(workflows), phases).name, "gamma");
	assert.throws(() => parsePhaseList("agent(builder, bounded"), /Unbalanced phase parentheses/);
});

test("failed scoped typecheck refuses handoff and removes the draft", () => {
	const { cwd, workflows } = fixture();
	const calls: string[] = [];
	const runner: CommandRunner = (command) => {
		calls.push(command);
		return { status: 2, stderr: "synthetic type error" };
	};
	assert.throws(() => makeWorkflow({ cwd, workflowsDir: workflows, name: "broken-compile", phases: ["agent(plan)"], runner }), /Scoped workflow typecheck failed.*synthetic type error/s);
	assert.equal(calls.length, 1);
	assert.throws(() => readFileSync(resolve(workflows, "wf-broken-compile.ts"), "utf8"), /ENOENT/);
});

test("failed dry run refuses handoff after a successful typecheck", () => {
	const { cwd, workflows } = fixture();
	let call = 0;
	const runner: CommandRunner = () => ++call === 1 ? { status: 0 } : { status: 1, stderr: "synthetic dry-run failure" };
	assert.throws(() => makeWorkflow({ cwd, workflowsDir: workflows, name: "broken-runtime", phases: ["agent(plan)", "agent(review)"], runner }), /Generated workflow dry run failed.*synthetic dry-run failure/s);
	assert.equal(call, 2);
	assert.throws(() => readFileSync(resolve(workflows, "wf-broken-runtime.ts"), "utf8"), /ENOENT/);
});
