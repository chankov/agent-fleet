// Role admission at dispatch (PLAN-11-01, tasks 1–2): a dispatch names a role and
// practices. Retired persona names and unknown practices are refused before any
// start or charge; the resolved assignment travels with the task to every route.
import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchExecutor, createResearchExecutor, prepareDispatch, validateDispatchAgent } from "./tools/dispatch-execution.ts";
import { prepareDeps } from "./tools/dispatch-execution.test-support.ts";
import { resolveDelegateTools } from "./helpers.ts";
import { dispatchAccess, isInspectionAccess } from "./dispatch-access.ts";
import { applyRoleCeiling } from "./config/roles.ts";
import { parseAgentFile } from "./config/agents.ts";

const ctx = { cwd: process.cwd(), ui: { notify() {} } } as any;
const text = (result: any) => result?.content?.[0]?.text ?? "";

test("a retired persona name is refused before any start, with its role and practice mapping", async () => {
	const d = prepareDeps({ agents: ["editor"] });
	for (const [name, role] of [["builder", "editor"], ["code-reviewer", "reviewer"], ["planner", "editor"], ["deep-researcher", "researcher"]] as const) {
		const refused = validateDispatchAgent(d as any, name, "work", ctx);
		assert.ok(refused, name);
		assert.equal(refused!.details.started, false);
		assert.equal(refused!.details.reason, "retired_persona");
		assert.match(text(refused), new RegExp(`"${name}" is a retired persona.*agent "${role}"`));
	}
	let launched = 0;
	(d as any).dispatchAgent = async () => { launched++; return { output: "", exitCode: 0, elapsed: 0 }; };
	const result = await createDispatchExecutor(d as any)("t", { agent: "builder", task: "implement" }, undefined, undefined, ctx);
	assert.equal(result.details.reason, "retired_persona");
	assert.equal(launched, 0, "nothing launched");
	assert.equal(d._task(), 0, "nothing charged");
});

test("unknown practices and practices outside the role are refused before any start", () => {
	const d = prepareDeps({ agents: ["editor", "reviewer"] });
	const unknown = validateDispatchAgent(d as any, "editor", "t", ctx, ["implementation", "vibes"]);
	assert.equal(unknown?.details.reason, "unknown_practice");
	assert.match(text(unknown), /Unknown practice "vibes"/);
	const wrongRole = validateDispatchAgent(d as any, "reviewer", "t", ctx, ["implementation"]);
	assert.equal(wrongRole?.details.reason, "incompatible_practice");
	assert.equal(validateDispatchAgent(d as any, "reviewer", "t", ctx, ["independent-review", "security"]), null);
});

test("the researcher role runs through spawn_research, never dispatch_agent", () => {
	const d = prepareDeps({ agents: ["editor"] });
	const refused = validateDispatchAgent(d as any, "researcher", "t", ctx, ["research"]);
	assert.equal(refused?.details.reason, "research_persona_via_dispatch");
	assert.match(text(refused), /Call spawn_research/);
});

test("the resolved assignment is appended to the task and bound into the resume contract", () => {
	const d = prepareDeps({ agents: ["editor"], tools: "read,write,edit,bash" });
	const prepared: any = prepareDispatch(d as any, { agent: "editor", task: "Add the parser.", practices: ["implementation", "testing"] }, ctx);
	assert.ok("agent" in prepared, text(prepared));
	assert.deepEqual(prepared.assignment.practices.map((entry: any) => entry.practice.id), ["implementation", "testing"]);
	assert.match(prepared.task, /^Add the parser\.\n\n## Assignment\nRole: editor/);
	assert.match(prepared.task, /### Testing\nExpected result: A reproduction, regression coverage or check results\./);
	assert.equal(prepared.resumeContract.instructions, prepared.task);
	const defaulted: any = prepareDispatch(prepareDeps({ agents: ["editor"], tools: "read,write" }) as any, { agent: "editor", task: "Fix it." }, ctx);
	assert.match(defaulted.task, /Practices: Implementation \(role default\)\./);
});

test("spawn_research carries researcher practices and refuses a retired research persona", async () => {
	const d = prepareDeps({ agents: ["editor"] });
	const prompts: string[] = [];
	(d as any).research = {
		anonymousDef: () => ({ name: "research", tools: "read,grep,find,ls" }),
		createState: (def: any) => ({ id: 1, def }),
		resolveModel: () => "provider/model",
		spawn: async (_state: any, prompt: string) => { prompts.push(prompt); return { output: "found", exitCode: 0, elapsed: 0 }; },
	};
	(d.state as any).getResearchPersonas = () => [{ name: "researcher", tools: "read,grep,find,ls" }];
	(d.state as any).getTurnReport = () => ({ refusals: 0, research: 0 });
	(d.state as any).getSessionTotals = () => ({ refusals: 0, research: 0 });
	const research = createResearchExecutor(d as any);
	const ok = await research("r", { task: "Which module owns the access rule?", practices: ["research", "security"] }, undefined, undefined, ctx);
	assert.equal(ok.details.exitCode, 0, text(ok));
	assert.match(prompts[0], /## Assignment\nRole: researcher/);
	assert.match(prompts[0], /Practices: Research, Security\./);
	const retired = await research("r2", { task: "deep dive", persona: "deep-researcher" }, undefined, undefined, ctx);
	assert.equal(retired.details.reason, "retired_persona");
	assert.match(text(retired), /agent "researcher" with practices \["research"\]/);
	const wrong = await research("r3", { task: "implement", practices: ["implementation"] }, undefined, undefined, ctx);
	assert.equal(wrong.details.reason, "incompatible_practice");
	assert.equal(prompts.length, 1, "refusals never spawn");
});

test("readers keep their ceiling on every path: inspection, active checks, delegated children", () => {
	const reviewer = applyRoleCeiling(parseAgentFile("agents/reviewer.md")!);
	const researcher = applyRoleCeiling(parseAgentFile("agents/researcher.md")!);
	const editor = applyRoleCeiling(parseAgentFile("agents/editor.md")!);
	for (const reader of [reviewer, researcher]) {
		for (const mode of [undefined, "changes"] as const) {
			const access = dispatchAccess(reader, mode);
			assert.equal(access.writable, false);
			assert.equal(isInspectionAccess(access), true);
			assert.equal(access.tools, "read,grep,find,ls");
		}
	}
	for (const mode of ["run-checks", "operator-current-state", "private-config-current-state"] as const) {
		const active = dispatchAccess(reviewer, mode);
		assert.deepEqual([active.writable, active.activeCheck], [false, true], `${mode} keeps the reviewer read-only`);
		assert.ok(!/write|edit/.test(active.tools));
		const research = dispatchAccess(researcher, mode);
		assert.deepEqual([research.writable, research.activeCheck ?? false, research.tools], [false, false, "read,grep,find,ls"], "a researcher has no shell to check with");
		// A delegated child asking for write gets at most the parent's read-only tool set.
		const child = resolveDelegateTools({ parentTools: active.tools, roleTools: "read,write,edit,bash", allowWrite: true });
		assert.ok(!/write|edit/.test(child.effectiveTools), child.effectiveTools);
	}
	assert.equal(dispatchAccess(editor).writable, true);
	assert.equal(dispatchAccess(editor, "run-checks").writable, true);
});

test("spawn_research runs two questions at once; the same question in flight is busy", async () => {
	const d = prepareDeps({ agents: ["editor"] });
	const releases: Array<() => void> = []; const prompts: string[] = [];
	(d as any).research = {
		anonymousDef: () => ({ name: "research", tools: "read,grep,find,ls" }),
		createState: (def: any) => ({ id: prompts.length + 1, def }),
		resolveModel: () => "provider/model",
		spawn: async (_state: any, prompt: string) => { prompts.push(prompt); await new Promise<void>(resolve => releases.push(resolve)); return { output: "found", exitCode: 0, elapsed: 0 }; },
	};
	(d.state as any).getTurnReport = () => ({ refusals: 0, research: 0 });
	(d.state as any).getSessionTotals = () => ({ refusals: 0, research: 0 });
	const research = createResearchExecutor(d as any);
	const first = research("q1", { task: "Which module owns the access rule?" }, undefined, undefined, ctx);
	const second = research("q2", { task: "Where is the retry budget enforced?", practices: ["research", "security"] }, undefined, undefined, ctx);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(prompts.length, 2, "two researchers investigate in parallel");
	const duplicate = await research("q3", { task: "which module owns the ACCESS rule" }, undefined, undefined, ctx);
	assert.equal(duplicate.details.status, "busy");
	assert.equal(prompts.length, 2);
	for (const release of releases) release();
	const results = await Promise.all([first, second]);
	assert.deepEqual(results.map(result => result.details.exitCode), [0, 0]);
});
