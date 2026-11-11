import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parallelWriterGate, type WriterEntry } from "./tools/dispatch-execution.ts";
import { confineNativeChild, linuxUserNamespaceSandboxAvailable } from "./write-isolation.ts";
import { checkScope, diffAgainst, snapshotWorktree } from "./scope-gate.js";

const hasLinuxSandbox = linuxUserNamespaceSandboxAvailable();

function gateDeps(active: WriterEntry[] | null, tools: Record<string, string> = { builder: "read,write,edit,bash", "code-reviewer": "read,bash,grep", researcher: "read,grep" }) {
	let refusals = 0;
	const agents = new Map(Object.entries(tools).map(([name, t]) => [name, { def: { name, tools: t }, status: "idle" }]));
	return {
		d: {
			state: {
				getAgentStates: () => agents,
				getActiveWriters: active ? () => active : undefined,
				getActiveWritableDispatches: () => (active === null ? 1 : 0),
				getTurnReport: () => ({ get refusals() { return refusals; }, set refusals(v: number) { refusals = v; } }),
				getSessionTotals: () => ({ refusals: 0 }),
			},
		} as any,
		refusals: () => refusals,
	};
}

const status = (result: any) => result?.details?.status ?? null;

test("a lone writer needs no flag; read-only dispatches never meet the gate", () => {
	assert.equal(parallelWriterGate(gateDeps([]).d, "builder", { agent: "builder", task: "t" }), null);
	const busy = gateDeps([{ agent: "builder", scope: ["src/a"], isolated: false }]);
	assert.equal(parallelWriterGate(busy.d, "researcher", { agent: "researcher", task: "t" }), null);
});

test("writes stay sequential unless every concurrent writer is parallel and isolated", () => {
	const unflagged = gateDeps([{ agent: "builder", scope: ["src/a"], isolated: true }]);
	const refused = parallelWriterGate(unflagged.d, "code-reviewer", { agent: "code-reviewer", task: "t" });
	assert.equal(status(refused), "writer_active", "a bash-capable reviewer is a writer too");
	assert.match((refused as any).content[0].text, /parallel: true and disjoint exact scopes/);
	assert.equal(refused && (refused as any).details.started, false);

	const open = gateDeps([{ agent: "builder", scope: ["src/a"], isolated: false }]);
	assert.equal(status(parallelWriterGate(open.d, "code-reviewer", { agent: "code-reviewer", task: "t", parallel: true, scope: ["src/b"] })), "writer_active_unisolated");

	const legacy = gateDeps(null);
	assert.equal(status(parallelWriterGate(legacy.d, "builder", { agent: "builder", task: "t", parallel: true, scope: ["src/b"] })), "writer_active_unisolated", "an unregistered writer counts as unisolated");
});

test("parallel writers need native, exact existing scopes, and disjoint scopes", () => {
	const active = gateDeps([{ agent: "builder", scope: ["src/a"], isolated: true }]);
	assert.equal(status(parallelWriterGate(active.d, "code-reviewer", { agent: "code-reviewer", task: "t", parallel: true, scope: ["src/a/x.ts"] })), "scope_overlap");
	assert.equal(parallelWriterGate(active.d, "code-reviewer", { agent: "code-reviewer", task: "t", parallel: true, scope: ["src/b"] }), null);
	assert.equal(parallelWriterGate(active.d, "code-reviewer", { agent: "code-reviewer", task: "t", parallel: true }), null, "an isolated empty scope writes nothing in the repository");

	const lone = gateDeps([]);
	assert.equal(status(parallelWriterGate(lone.d, "builder", { agent: "builder", task: "t", parallel: true, scope: ["src/*.ts"] })), "parallel_scope_invalid");
	assert.equal(status(parallelWriterGate(lone.d, "builder", { agent: "builder", task: "t", parallel: true, scope: ["src/new"], scope_mode: "create" })), "parallel_scope_invalid");
	assert.equal(status(parallelWriterGate(lone.d, "builder", { agent: "builder", task: "t", parallel: true, scope: ["src/a"], backend: "coms" })), "parallel_requires_native");
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "fleet-parallel-writers-"));
	for (const dir of ["a", "b", "runtime-a", "runtime-b"]) mkdirSync(join(root, dir));
	writeFileSync(join(root, "a", "one.txt"), "a-before\n");
	writeFileSync(join(root, "b", "two.txt"), "b-before\n");
	writeFileSync(join(root, ".gitignore"), "runtime-*/\n");
	const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q"); git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
	git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "base");
	return root;
}

function sandboxed(root: string, scope: string, runtime: string, script: string) {
	const launch = confineNativeChild({ enabled: true, cwd: root, allowlist: [scope], runtimePaths: [join(root, runtime)], command: "/bin/sh", args: ["-c", script] });
	assert.equal(launch.applied, true, launch.reason);
	return new Promise<number>(resolve => {
		const child = spawn(launch.command!, launch.args!, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: "ignore" });
		child.on("exit", code => resolve(code ?? 1));
	});
}

test("two concurrent sandboxed writers with disjoint scopes each change only their own scope", { skip: !hasLinuxSandbox }, async t => {
	const root = repo();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const before = snapshotWorktree(root, ["a/", "b/"]);
	// Each writer edits its own file, then tries to touch the other's area; the OS must refuse.
	const [first, second] = await Promise.all([
		sandboxed(root, "a/", "runtime-a", "printf a-after > a/one.txt; (printf x > b/two.txt) 2>/dev/null && exit 41; (printf x > b/new.txt) 2>/dev/null && exit 42; exit 0"),
		sandboxed(root, "b/", "runtime-b", "printf b-after > b/two.txt; (printf x > a/one.txt) 2>/dev/null && exit 43; exit 0"),
	]);
	assert.deepEqual([first, second], [0, 0], "cross-scope writes were refused inside the sandbox");
	assert.equal(readFileSync(join(root, "a", "one.txt"), "utf8"), "a-after");
	assert.equal(readFileSync(join(root, "b", "two.txt"), "utf8"), "b-after");

	const diff = diffAgainst(before, root);
	assert.equal(diff.skipped, false, diff.reason);
	assert.deepEqual(diff.paths.sort(), ["a/one.txt", "b/two.txt"]);
	// Attribution as dispatch-execution does it for an isolated writer: only its own scope.
	assert.deepEqual(checkScope(diff.paths, ["a/"]).inScope, ["a/one.txt"]);
	assert.deepEqual(checkScope(diff.paths, ["b/"]).inScope, ["b/two.txt"]);
});
