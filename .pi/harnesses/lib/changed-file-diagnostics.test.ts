import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	acquireBuildInfoCache,
	compilerArgv,
	diagnoseChangedTypeScript,
	formatAdvisory,
	groupDiagnostics,
	parseCompilerOutput,
	resolveChangedFileProjects,
	runProcess,
	runProjectDiagnostics,
	type DiagnosticsResult,
	type ResolvedTypeScriptProject,
} from "./changed-file-diagnostics.ts";

test("parseCompilerOutput preserves positioned, global, and multiline diagnostics", () => {
	const diagnostics = parseCompilerOutput([
		"src/api.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
		"  The assignment is downstream.",
		"error TS5083: Cannot read file 'missing.json'.",
	].join("\n"));
	assert.deepEqual(diagnostics, [
		{ file: "src/api.ts", line: 4, column: 7, code: 2322, message: "Type 'string' is not assignable to type 'number'.\n  The assignment is downstream." },
		{ code: 5083, message: "Cannot read file 'missing.json'." },
	]);
});

test("groupDiagnostics retains downstream and global errors", () => {
	const raw = [
		{ file: "src/api.ts", line: 2, code: 2322, message: "changed" },
		{ file: "src/consumer.ts", line: 8, code: 2339, message: "downstream" },
		{ code: 5083, message: "global" },
	];
	assert.deepEqual(groupDiagnostics(raw, ["./src/api.ts"]), {
		inChangedFiles: [raw[0]],
		elsewhere: [raw[1], raw[2]],
	});
});

test("build-info cache leases isolate concurrent runs and preserve the warm lane", () => {
	const cacheRoot = mkdtempSync(join(tmpdir(), "af-diagnostics-cache-"));
	const input = {
		cacheRoot,
		worktree: "/repo/worktree",
		project: "/repo/worktree/pkg/tsconfig.json",
		compilerVersion: "5.9.3",
		lane: "builder",
	};
	const first = acquireBuildInfoCache({ ...input, runId: "run-1" });
	const concurrent = acquireBuildInfoCache({ ...input, runId: "run-2" });
	const otherVersion = acquireBuildInfoCache({ ...input, compilerVersion: "5.8.0", runId: "run-3" });
	assert.notEqual(concurrent.file, first.file);
	assert.notEqual(otherVersion.file, first.file);
	const cacheRelative = relative(cacheRoot, first.file);
	assert.ok(!isAbsolute(cacheRelative) && !cacheRelative.startsWith(".."), first.file);
	first.release();
	const warm = acquireBuildInfoCache({ ...input, runId: "run-3" });
	assert.equal(warm.file, first.file);
	concurrent.release();
	warm.release();
	otherVersion.release();
	const defaultExternal = acquireBuildInfoCache({ ...input, cacheRoot: undefined, runId: "run-4" });
	assert.ok(defaultExternal.file.startsWith(join(tmpdir(), "agent-fleet-diagnostics")));
	defaultExternal.release();
});

function projectFixture(config: Record<string, unknown> = { compilerOptions: { strict: true }, include: ["src/**/*"], exclude: ["src/excluded.ts"] }) {
	const root = mkdtempSync(join(tmpdir(), "af-diagnostics-project-"));
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	symlinkSync(join(repositoryRoot, "node_modules", "typescript"), join(root, "node_modules", "typescript"), process.platform === "win32" ? "junction" : "dir");
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify(config), "utf8");
	for (const file of ["api.ts", "view.tsx", "types.cts", "excluded.ts", "consumer.ts"]) {
		writeFileSync(join(root, "src", file), "export {};\n", "utf8");
	}
	return root;
}

test("resolver selects nearest standard configs, handles deleted files and every TS extension, and honors excludes", async () => {
	const root = projectFixture();
	writeFileSync(join(root, "src", "nested", "tsconfig.json"), JSON.stringify({ include: ["*.tsx"] }), "utf8");
	writeFileSync(join(root, "src", "nested", "component.tsx"), "export {};\n", "utf8");
	const changed = [
		"src/api.ts", "src/view.tsx", "src/deleted.mts", "src/types.cts", "src/excluded.ts",
		"src/nested/component.tsx", "src/nested/not-covered.ts", "README.md",
	];
	const result = await resolveChangedFileProjects(changed, { cwd: root }, { findGitRoot: () => root });
	assert.equal(result.projects.length, 2);
	assert.deepEqual(result.projects.find((entry) => entry.project === join(root, "tsconfig.json"))?.changedFiles,
		["src/api.ts", "src/deleted.mts", "src/types.cts", "src/view.tsx"]);
	assert.deepEqual(result.projects.find((entry) => entry.project.endsWith(join("nested", "tsconfig.json")))?.changedFiles,
		["src/nested/component.tsx"]);
	assert.deepEqual(result.uncoveredFiles, ["src/excluded.ts", "src/nested/not-covered.ts"]);
	const excludedOnly = await diagnoseChangedTypeScript(["src/excluded.ts"], { cwd: root }, { findGitRoot: () => root });
	assert.equal(excludedOnly.status, "incomplete");
	assert.deepEqual(excludedOnly.projects, []);
});

test("resolver anchors root-relative paths to the actual git root", async () => {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const result = await resolveChangedFileProjects(
		[".pi/agent-fleet/scripts/workflows/wf-quality.ts"],
		{ cwd: join(repositoryRoot, ".pi", "harnesses") },
	);
	assert.equal(result.gitRoot, repositoryRoot);
	assert.deepEqual(result.projects.map((entry) => entry.project), [join(repositoryRoot, ".pi", "agent-fleet", "scripts", "workflows", "tsconfig.json")]);
});

test("resolver does not claim solution or framework projects are covered", async () => {
	for (const config of [
		{ references: [{ path: "./child" }], include: ["src/**/*"] },
		{ angularCompilerOptions: {}, include: ["src/**/*"] },
	]) {
		const root = projectFixture(config);
		const result = await resolveChangedFileProjects(["src/api.ts"], { cwd: root }, { findGitRoot: () => root });
		assert.equal(result.projects.length, 0);
		assert.equal(result.unavailableProjects.length, 1);
		assert.equal(result.unavailableProjects[0].status, "unavailable");
		assert.deepEqual(result.uncoveredFiles, ["src/api.ts"]);
	}
});

test("real TypeScript config errors are unavailable and preserve every config diagnostic", async () => {
	const cases: Array<{ name: string; config: string; changed: string; codes: number[] }> = [
		{ name: "malformed JSON", config: '{"include": ["src/**/*",]', changed: "src/api.ts", codes: [1005] },
		{ name: "invalid option", config: JSON.stringify({ compilerOptions: { definitelyNotATypeScriptOption: true }, include: ["src/**/*"] }), changed: "src/api.ts", codes: [5023] },
		{ name: "missing extends", config: JSON.stringify({ extends: "./missing-base.json", include: ["src/**/*"] }), changed: "src/api.ts", codes: [5083] },
		{
			name: "invalid option on excluded path",
			config: JSON.stringify({ compilerOptions: { definitelyNotATypeScriptOption: true }, include: ["src/excluded.ts"], exclude: ["src/excluded.ts"] }),
			changed: "src/excluded.ts",
			codes: [5023, 18003],
		},
	];
	for (const fixture of cases) {
		const root = projectFixture();
		writeFileSync(join(root, "tsconfig.json"), fixture.config, "utf8");
		const result = await diagnoseChangedTypeScript([fixture.changed], { cwd: root }, { findGitRoot: () => root });
		assert.equal(result.status, "incomplete", fixture.name);
		assert.equal(result.projects.length, 1, fixture.name);
		assert.equal(result.projects[0].status, "unavailable", fixture.name);
		assert.deepEqual(result.projects[0].diagnostics.map((diagnostic) => diagnostic.code), fixture.codes, fixture.name);
		assert.match(result.projects[0].reason ?? "", /config/i, fixture.name);
		assert.deepEqual(result.uncoveredFiles, [fixture.changed], fixture.name);
	}
});

test("valid exclusions and missing config candidates do not become config failures", async () => {
	const excludedRoot = projectFixture();
	const excluded = await diagnoseChangedTypeScript(["src/excluded.ts"], { cwd: excludedRoot }, { findGitRoot: () => excludedRoot });
	assert.equal(excluded.status, "incomplete");
	assert.deepEqual(excluded.projects, []);
	assert.match(excluded.reason ?? "", /excludes|could not be verified/);

	const noConfig = mkdtempSync(join(tmpdir(), "af-diagnostics-no-config-"));
	const skipped = await diagnoseChangedTypeScript(["deleted.ts"], { cwd: noConfig }, { findGitRoot: () => noConfig });
	assert.equal(skipped.status, "skipped");
	assert.deepEqual(skipped.projects, []);
	assert.equal(formatAdvisory(skipped), "");
});

test("resolver reports absent config and absent local compiler without fallback", async () => {
	const noConfig = mkdtempSync(join(tmpdir(), "af-diagnostics-no-config-"));
	const skipped = await diagnoseChangedTypeScript(["deleted.ts"], { cwd: noConfig }, { findGitRoot: () => noConfig });
	assert.equal(skipped.status, "skipped");
	assert.deepEqual(skipped.uncoveredFiles, ["deleted.ts"]);

	const noCompiler = mkdtempSync(join(tmpdir(), "af-diagnostics-no-compiler-"));
	writeFileSync(join(noCompiler, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }), "utf8");
	const incomplete = await diagnoseChangedTypeScript(["deleted.ts"], { cwd: noCompiler }, { findGitRoot: () => noCompiler });
	assert.equal(incomplete.status, "incomplete");
	assert.match(incomplete.projects[0].reason ?? "", /local TypeScript compiler not found/);
});

test("diagnoseChangedTypeScript uses required argv and preserves downstream/global diagnostics and raw evidence", async () => {
	const root = projectFixture();
	let invocation: { file: string; args: string[]; timeoutMs: number } | undefined;
	const result = await diagnoseChangedTypeScript(["src/api.ts"], {
		cwd: root, cacheRoot: join(root, "external-cache"), cacheLane: "builder", runId: "run-a",
	}, {
		findGitRoot: () => root,
		runProcess: async (file, args, options) => {
			invocation = { file, args, timeoutMs: options.timeoutMs };
			return {
				exitCode: 2,
				stdout: [
					"src/api.ts(1,2): error TS2322: changed error",
					"src/consumer.ts(3,4): error TS2339: downstream error",
					"error TS5083: global error",
				].join("\n"),
				stderr: "raw stderr",
				durationMs: 12,
			};
		},
	});
	assert.equal(result.status, "completed");
	assert.equal(result.projects[0].status, "errors");
	assert.equal(result.projects[0].exitCode, 2);
	assert.equal(result.projects[0].diagnostics.length, 3);
	assert.match(result.projects[0].stdout, /downstream error/);
	assert.equal(result.projects[0].stderr, "raw stderr");
	assert.equal(invocation?.file, process.execPath);
	assert.deepEqual(invocation?.args.slice(1, 8), [
		"--project", join(root, "tsconfig.json"), "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile",
	]);
	assert.equal(invocation?.timeoutMs, 10_000);
});

test("real local compiler reports diagnostics in unchanged consumers", async () => {
	const root = projectFixture();
	writeFileSync(join(root, "src", "api.ts"), "export const value = 1;\n", "utf8");
	writeFileSync(join(root, "src", "consumer.ts"), "import { value } from './api.js';\nconst text: string = value;\n", "utf8");
	const result = await diagnoseChangedTypeScript(["src/api.ts"], {
		cwd: root,
		cacheRoot: mkdtempSync(join(tmpdir(), "af-diagnostics-real-cache-")),
		cacheLane: "real",
	}, { findGitRoot: () => root });
	assert.equal(result.status, "completed");
	assert.equal(result.projects[0].status, "errors");
	assert.notEqual(result.projects[0].exitCode, 0);
	assert.ok(result.projects[0].diagnostics.some((diagnostic) => diagnostic.file === "src/consumer.ts" && diagnostic.code === 2322));
	assert.deepEqual(groupDiagnostics(result.projects[0].diagnostics, result.changedFiles).inChangedFiles, []);
	assert.match(result.projects[0].stdout, /src\/consumer\.ts/);
});

test("nonzero without parseable positions remains an error and retains output", async () => {
	const project: ResolvedTypeScriptProject = {
		project: "/repo/tsconfig.json", changedFiles: ["src/a.ts"], compilerPath: "/repo/node_modules/typescript/bin/tsc", compilerVersion: "5.9.3",
	};
	const result = await runProjectDiagnostics(project, { gitRoot: "/repo", cacheRoot: mkdtempSync(join(tmpdir(), "af-diagnostics-cache-")) }, {
		runProcess: async () => ({ exitCode: 1, stdout: "unexpected compiler output", stderr: "raw failure", durationMs: 1 }),
	});
	assert.equal(result.status, "errors");
	assert.match(result.reason ?? "", /without parseable diagnostics/);
	assert.equal(result.stdout, "unexpected compiler output");
	assert.equal(result.stderr, "raw failure");
});

test("timeout and spawn failure are unavailable without throwing", async () => {
	const processResult = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 30 });
	assert.equal(processResult.timedOut, true);
	assert.match(processResult.stderr, /Timed out after 30ms/);

	const project: ResolvedTypeScriptProject = {
		project: "/repo/tsconfig.json", changedFiles: ["src/a.ts"], compilerPath: "/repo/node_modules/typescript/bin/tsc", compilerVersion: "5.9.3",
	};
	const timed = await runProjectDiagnostics(project, { gitRoot: "/repo", cacheRoot: mkdtempSync(join(tmpdir(), "af-diagnostics-cache-")), timeoutMs: 25 }, {
		runProcess: async () => ({ exitCode: null, stdout: "partial", stderr: "timeout", durationMs: 25, timedOut: true }),
	});
	assert.equal(timed.status, "unavailable");
	assert.equal(timed.exitCode, null);
	assert.match(timed.reason ?? "", /timed out/);
	assert.equal(timed.stdout, "partial");

	const failed = await runProjectDiagnostics(project, {
		gitRoot: "/repo", cacheRoot: mkdtempSync(join(tmpdir(), "af-diagnostics-cache-")), nodeExecutable: join(tmpdir(), "missing-node"),
	});
	assert.equal(failed.status, "unavailable");
	assert.match(failed.reason ?? "", /spawn failed/);

	const thrown = await runProjectDiagnostics(project, { gitRoot: "/repo", cacheRoot: mkdtempSync(join(tmpdir(), "af-diagnostics-cache-")) }, {
		runProcess: async () => { throw new Error("runner exploded"); },
	});
	assert.equal(thrown.status, "unavailable");
	assert.match(thrown.reason ?? "", /runner exploded/);
});

test("compilerArgv has no npx, global fallback, or file-mode arguments", () => {
	const project: ResolvedTypeScriptProject = {
		project: "/repo/tsconfig.json", changedFiles: ["src/a.ts"], compilerPath: "/repo/node_modules/typescript/bin/tsc", compilerVersion: "5.9.3",
	};
	assert.deepEqual(compilerArgv(project, "/tmp/cache.tsbuildinfo", "/node"), [
		"/node", project.compilerPath, "--project", project.project, "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", "/tmp/cache.tsbuildinfo",
	]);
});

test("formatAdvisory bounds display while preserving the result diagnostics", () => {
	const diagnostics = Array.from({ length: 15 }, (_, index) => ({
		file: index < 12 ? "src/changed.ts" : `src/downstream-${index}.ts`,
		line: index + 1,
		code: 2300 + index,
		message: `diagnostic ${index}`,
	}));
	const result: DiagnosticsResult = {
		status: "completed",
		changedFiles: ["src/changed.ts"],
		attribution: "no_observed_overlap",
		projects: [{
			project: "/repo/tsconfig.json",
			status: "errors",
			exitCode: 2,
			diagnostics,
			argv: ["node", "tsc", "--project", "/repo/tsconfig.json"],
			stdout: "full stdout",
			stderr: "full stderr",
		}],
	};
	const advisory = formatAdvisory(result);
	assert.equal(result.projects[0].diagnostics.length, 15);
	assert.match(advisory, /Compiler errors/);
	assert.match(advisory, /12 more diagnostics omitted|2 more diagnostics omitted/);
	assert.ok(advisory.split("\n").length <= 25, advisory);
});

test("real compiler through symlinked worktree keeps changed and downstream paths root-relative", async t => {
 const root = projectFixture();
 const holder = mkdtempSync(join(tmpdir(), "af-diagnostics-alias-"));
 const alias = join(holder, "linked-project");
 symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
 t.after(() => { rmSync(holder, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
 writeFileSync(join(root, "src/api.ts"), "export const value: number = 'broken';\n");
 writeFileSync(join(root, "src/consumer.ts"), "import {value} from './api.js'; const text: string = value;\n");
 const result = await diagnoseChangedTypeScript(["src/api.ts"], { cwd: alias, cacheRoot: join(holder, "cache") }, { findGitRoot: () => alias });
 assert.equal(result.projects[0].status, "errors");
 const groups = groupDiagnostics(result.projects[0].diagnostics, result.changedFiles);
 assert.ok(groups.inChangedFiles.some(d => d.file === "src/api.ts" && d.code === 2322), JSON.stringify(result));
 assert.ok(groups.elsewhere.some(d => d.file === "src/consumer.ts" && d.code === 2322), JSON.stringify(result));
});
