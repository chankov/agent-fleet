import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export const DEFAULT_PROJECT_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_KILL_GRACE_MS = 250;
export const DEFAULT_ADVISORY_CHANGED_LIMIT = 10;
export const DEFAULT_ADVISORY_ELSEWHERE_LIMIT = 10;
export const DEFAULT_ADVISORY_PROJECT_LIMIT = 10;
export const DEFAULT_ADVISORY_MESSAGE_CHARS = 500;

export interface Diagnostic {
	file?: string;
	line?: number;
	column?: number;
	code: number;
	message: string;
}

export interface ProjectDiagnostics {
	project: string;
	status: "passed" | "errors" | "unavailable";
	exitCode: number | null;
	reason?: string;
	diagnostics: Diagnostic[];
	/** Complete process evidence. Callers persist this outside compact tool output. */
	argv: string[];
	stdout: string;
	stderr: string;
	durationMs?: number;
	compilerVersion?: string;
	changedFiles?: string[];
}

export interface DiagnosticsResult {
	status: "skipped" | "completed" | "incomplete";
	reason?: string;
	changedFiles: string[];
	attribution: "no_observed_overlap" | "uncertain";
	projects: ProjectDiagnostics[];
	uncoveredFiles?: string[];
}

export interface BuildInfoCacheLease {
	file: string;
	contended: boolean;
	release(): void;
}

export interface ResolvedTypeScriptProject {
	project: string;
	changedFiles: string[];
	compilerPath: string;
	compilerVersion: string;
}

export interface ProjectResolution {
	gitRoot?: string;
	changedFiles: string[];
	projects: ResolvedTypeScriptProject[];
	unavailableProjects: ProjectDiagnostics[];
	uncoveredFiles: string[];
	hadProjectCandidates: boolean;
	reason?: string;
}

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut?: boolean;
	spawnError?: string;
}

export type ProcessRunner = (
	file: string,
	args: string[],
	options: { cwd: string; timeoutMs: number },
) => Promise<ProcessResult>;

type TypeScriptConfigDiagnostic = {
	code: number;
	messageText: unknown;
	file?: {
		fileName: string;
		getLineAndCharacterOfPosition(position: number): { line: number; character: number };
	};
	start?: number;
};

type TypeScriptApi = {
	sys: {
		useCaseSensitiveFileNames: boolean;
		readFile(path: string): string | undefined;
		readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[];
	};
	readConfigFile(path: string, readFile: (path: string) => string | undefined): { config?: Record<string, unknown>; error?: TypeScriptConfigDiagnostic };
	parseJsonConfigFileContent(config: Record<string, unknown>, host: Record<string, unknown>, basePath: string, existingOptions?: unknown, configFileName?: string): { fileNames: string[]; errors: TypeScriptConfigDiagnostic[] };
	getFileMatcherPatterns(path: string, excludes: readonly string[] | undefined, includes: readonly string[] | undefined, caseSensitive: boolean, currentDirectory: string): { includeFilePattern?: string; excludePattern?: string };
	flattenDiagnosticMessageText(message: unknown, newLine: string): string;
};

export interface DiagnosticsDependencies {
	findGitRoot?: (cwd: string) => string;
	exists?: (path: string) => boolean;
	readFile?: (path: string, encoding: "utf8") => string;
	loadTypeScript?: (compilerPath: string) => Promise<TypeScriptApi>;
	runProcess?: ProcessRunner;
	now?: () => number;
	acquireCache?: typeof acquireBuildInfoCache;
}

export interface DiagnosticsOptions {
	cwd?: string;
	attribution?: DiagnosticsResult["attribution"];
	cacheRoot?: string;
	cacheLane?: string;
	runId?: string;
	projectTimeoutMs?: number;
	totalTimeoutMs?: number;
	nodeExecutable?: string;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "default";
}

/**
 * Reserve a cache lane outside the worktree. The stable lane retains warm data;
 * an overlapping run receives a unique fallback and never shares a writer.
 */
export function acquireBuildInfoCache(input: {
	worktree: string;
	project: string;
	compilerVersion: string;
	lane?: string;
	runId?: string;
	cacheRoot?: string;
}): BuildInfoCacheLease {
	const directory = join(
		input.cacheRoot ?? join(tmpdir(), "agent-fleet-diagnostics"),
		shortHash(resolve(input.worktree)),
		shortHash(resolve(input.project)),
		`typescript-${safeSegment(input.compilerVersion)}`,
	);
	mkdirSync(directory, { recursive: true });
	const lane = safeSegment(input.lane ?? "default");
	const stableFile = join(directory, `${lane}.tsbuildinfo`);
	const lockFile = `${stableFile}.lock`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(lockFile, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (descriptor === undefined) {
		return {
			file: join(directory, `${lane}-${shortHash(input.runId ?? randomUUID())}.tsbuildinfo`),
			contended: true,
			release() {},
		};
	}
	let released = false;
	return {
		file: stableFile,
		contended: false,
		release() {
			if (released) return;
			released = true;
			try { closeSync(descriptor); } catch {}
			try { unlinkSync(lockFile); } catch {}
		},
	};
}

/** Parse every standard `--pretty false` TypeScript error, including globals. */
export function parseCompilerOutput(output: string, cwd = process.cwd()): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of String(output || "").split(/\r?\n/)) {
		const positioned = line.match(/^(.*)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s?(.*)$/);
		const global = positioned ? null : line.match(/^error\s+TS(\d+):\s?(.*)$/);
		if (positioned) {
			const rawFile = positioned[1];
			const file = normalizeEvidencePath(rawFile, cwd);
			diagnostics.push({ file, line: Number(positioned[2]), column: Number(positioned[3]), code: Number(positioned[4]), message: positioned[5] });
		} else if (global) {
			diagnostics.push({ code: Number(global[1]), message: global[2] });
		} else if (line && diagnostics.length) {
			diagnostics[diagnostics.length - 1].message += `\n${line}`;
		}
	}
	return diagnostics;
}

function canonicalPath(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

function normalizeEvidencePath(file: string, cwd: string): string {
	// A child process observes the physical cwd, even when the supplied worktree
	// uses a symlink (macOS /var -> /private/var). tsc may print ../alias/src/a.ts.
	// Resolve both spellings before grouping, otherwise changed errors become
	// incorrectly classified as downstream errors and evade contract correction.
	const root = canonicalPath(cwd);
	const absolute = canonicalPath(resolve(root, file));
	const rel = relative(root, absolute).replace(/\\/g, "/");
	if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return rel;
	return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Group for display without discarding downstream or global diagnostics. */
export function groupDiagnostics(raw: Diagnostic[], changed: readonly string[]): {
	inChangedFiles: Diagnostic[];
	elsewhere: Diagnostic[];
} {
	const changedSet = new Set(changed.map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")));
	const inChangedFiles: Diagnostic[] = [];
	const elsewhere: Diagnostic[] = [];
	for (const diagnostic of raw) {
		const file = diagnostic.file?.replace(/\\/g, "/").replace(/^\.\//, "");
		(file && changedSet.has(file) ? inChangedFiles : elsewhere).push(diagnostic);
	}
	return { inChangedFiles, elsewhere };
}

function formatDiagnostic(diagnostic: Diagnostic): string {
	const position = diagnostic.file
		? `${diagnostic.file}${diagnostic.line == null ? "" : `:${diagnostic.line}${diagnostic.column == null ? "" : `:${diagnostic.column}`}`}`
		: "global";
	const compact = diagnostic.message.replace(/\s+/g, " ").trim();
	const message = compact.length > DEFAULT_ADVISORY_MESSAGE_CHARS
		? `${compact.slice(0, DEFAULT_ADVISORY_MESSAGE_CHARS - 1)}…`
		: compact;
	return `${position} — TS${diagnostic.code}: ${message}`;
}

/** Compact, deterministic presentation; raw evidence and diagnostics remain untouched. */
export function formatAdvisory(result: DiagnosticsResult): string {
	if (result.status === "skipped") return "";
	const lines: string[] = [];
	let changedBudget = DEFAULT_ADVISORY_CHANGED_LIMIT;
	let elsewhereBudget = DEFAULT_ADVISORY_ELSEWHERE_LIMIT;
	for (const project of result.projects.slice(0, DEFAULT_ADVISORY_PROJECT_LIMIT)) {
		if (project.status === "passed") continue;
		if (project.status === "unavailable") {
			lines.push(`⚠ Compiler unavailable for ${basename(project.project)}: ${project.reason ?? "unknown reason"}`);
			continue;
		}
		if (!lines.length) lines.push("⚠ Compiler errors (agent run completed):");
		lines.push(`Project: ${project.project}`);
		const grouped = groupDiagnostics(project.diagnostics, result.changedFiles);
		const shownChanged = grouped.inChangedFiles.slice(0, Math.max(0, changedBudget));
		const shownElsewhere = grouped.elsewhere.slice(0, Math.max(0, elsewhereBudget));
		if (shownChanged.length) lines.push("Observed changed files:", ...shownChanged.map((item) => `  ${formatDiagnostic(item)}`));
		if (grouped.inChangedFiles.length > shownChanged.length) lines.push(`  … ${grouped.inChangedFiles.length - shownChanged.length} more diagnostics omitted`);
		if (shownElsewhere.length) lines.push("Elsewhere:", ...shownElsewhere.map((item) => `  ${formatDiagnostic(item)}`));
		if (grouped.elsewhere.length > shownElsewhere.length) lines.push(`  … ${grouped.elsewhere.length - shownElsewhere.length} more diagnostics omitted`);
		changedBudget -= shownChanged.length;
		elsewhereBudget -= shownElsewhere.length;
		lines.push(`Compiler exit: ${project.exitCode ?? "unavailable"}.`);
	}
	if (result.projects.length > DEFAULT_ADVISORY_PROJECT_LIMIT) lines.push(`… ${result.projects.length - DEFAULT_ADVISORY_PROJECT_LIMIT} more projects omitted`);
	if (result.uncoveredFiles?.length) lines.push(`Uncovered TypeScript paths: ${result.uncoveredFiles.length}.`);
	if (!lines.length && result.status === "incomplete") lines.push(`⚠ Compiler diagnostics incomplete: ${result.reason ?? "verification did not complete"}`);
	if (lines.length) lines.push(result.attribution === "uncertain"
		? "Concurrent worktree activity observed; attribution is uncertain."
		: "This result does not establish who introduced the errors.");
	return lines.join("\n");
}

const TS_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function defaultGitRoot(cwd: string): string {
	return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function nearestConfig(file: string, gitRoot: string, exists: (path: string) => boolean): string | undefined {
	let directory = dirname(file);
	while (isWithin(gitRoot, directory)) {
		const candidate = join(directory, "tsconfig.json");
		if (exists(candidate)) return candidate;
		if (directory === gitRoot) break;
		directory = dirname(directory);
	}
	return undefined;
}

function findLocalCompiler(project: string, gitRoot: string, exists: (path: string) => boolean): string | undefined {
	let directory = dirname(project);
	while (isWithin(gitRoot, directory)) {
		const candidate = join(directory, "node_modules", "typescript", "bin", "tsc");
		if (exists(candidate)) return candidate;
		if (directory === gitRoot) break;
		directory = dirname(directory);
	}
	return undefined;
}

function compilerVersion(compilerPath: string, readFile: (path: string, encoding: "utf8") => string): string {
	const packageJson = join(dirname(dirname(compilerPath)), "package.json");
	const parsed = JSON.parse(readFile(packageJson, "utf8"));
	if (typeof parsed.version !== "string" || !parsed.version) throw new Error("local TypeScript package has no version");
	return parsed.version;
}

async function defaultLoadTypeScript(compilerPath: string): Promise<TypeScriptApi> {
	const modulePath = join(dirname(dirname(compilerPath)), "lib", "typescript.js");
	const loaded = await import(pathToFileURL(modulePath).href);
	return (loaded.default ?? loaded) as TypeScriptApi;
}

function unsupportedConfig(config: Record<string, unknown>): string | undefined {
	if (Array.isArray(config.references) && config.references.length) return "project references require a build-mode compiler and are unsupported";
	for (const key of ["angularCompilerOptions", "vueCompilerOptions", "svelteOptions"]) {
		if (key in config) return `${key} requires a framework-specific compiler and is unsupported`;
	}
	const compilerOptions = config.compilerOptions as { plugins?: Array<{ name?: string }> } | undefined;
	const frameworkPlugin = compilerOptions?.plugins?.find((plugin) => /(?:angular|vue|svelte)/i.test(plugin?.name ?? ""));
	if (frameworkPlugin) return `compiler plugin ${frameworkPlugin.name ?? "unknown"} requires framework-specific coverage`;
	return undefined;
}

function unavailableProject(project: string, changedFiles: string[], reason: string, diagnostics: Diagnostic[] = []): ProjectDiagnostics {
	return { project, status: "unavailable", exitCode: null, reason, diagnostics, argv: [], stdout: "", stderr: "", changedFiles };
}

function configDiagnostics(ts: TypeScriptApi, raw: readonly TypeScriptConfigDiagnostic[], cwd: string): Diagnostic[] {
	return raw.map((item) => {
		const diagnostic: Diagnostic = {
			code: item.code,
			message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
		};
		if (item.file) diagnostic.file = normalizeEvidencePath(item.file.fileName, cwd);
		if (item.file && item.start != null) {
			const position = item.file.getLineAndCharacterOfPosition(item.start);
			diagnostic.line = position.line + 1;
			diagnostic.column = position.character + 1;
		}
		return diagnostic;
	});
}

const EMPTY_INPUT_CONFIG_DIAGNOSTICS = new Set([18002, 18003]);

function virtualReadDirectory(
	ts: TypeScriptApi,
	virtualFiles: readonly string[],
	currentDirectory: string,
): TypeScriptApi["sys"]["readDirectory"] {
	return (path, extensions, excludes, includes, depth) => {
		const actual = ts.sys.readDirectory(path, extensions, excludes, includes, depth);
		const patterns = ts.getFileMatcherPatterns(path, excludes, includes, ts.sys.useCaseSensitiveFileNames, currentDirectory);
		const include = patterns.includeFilePattern ? new RegExp(patterns.includeFilePattern, ts.sys.useCaseSensitiveFileNames ? "" : "i") : undefined;
		const exclude = patterns.excludePattern ? new RegExp(patterns.excludePattern, ts.sys.useCaseSensitiveFileNames ? "" : "i") : undefined;
		const extensionSet = new Set((extensions ?? []).map((extension) => extension.toLowerCase()));
		const added = virtualFiles.filter((file) => {
			const normalized = resolve(file).replace(/\\/g, "/");
			if (!isWithin(resolve(path), resolve(file))) return false;
			if (extensionSet.size && ![...extensionSet].some((extension) => normalized.toLowerCase().endsWith(extension))) return false;
			return (!include || include.test(normalized)) && (!exclude || !exclude.test(normalized));
		});
		return uniqueSorted([...actual.map((file) => resolve(file)), ...added.map((file) => resolve(file))]);
	};
}

/** Resolve nearest standard projects and prove changed-file membership with the local TS parser. */
export async function resolveChangedFileProjects(
	changedFiles: readonly string[],
	options: { cwd?: string } = {},
	deps: DiagnosticsDependencies = {},
): Promise<ProjectResolution> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const tsFiles = uniqueSorted(changedFiles.filter((file) => TS_EXTENSION.test(file)).map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")));
	if (!tsFiles.length) return { changedFiles: [], projects: [], unavailableProjects: [], uncoveredFiles: [], hadProjectCandidates: false, reason: "no TypeScript files changed" };
	let gitRoot: string;
	try {
		gitRoot = resolve((deps.findGitRoot ?? defaultGitRoot)(cwd));
	} catch (error) {
		return { changedFiles: tsFiles, projects: [], unavailableProjects: [], uncoveredFiles: tsFiles, hadProjectCandidates: false, reason: `git root unavailable: ${String(error)}` };
	}
	const exists = deps.exists ?? existsSync;
	const readFile = deps.readFile ?? readFileSync;
	const byProject = new Map<string, string[]>();
	const uncovered = new Set<string>();
	for (const changed of tsFiles) {
		const absolute = isAbsolute(changed) ? resolve(changed) : resolve(gitRoot, changed);
		if (!isWithin(gitRoot, absolute)) { uncovered.add(changed); continue; }
		const project = nearestConfig(absolute, gitRoot, exists);
		if (!project) { uncovered.add(changed); continue; }
		const files = byProject.get(project) ?? [];
		files.push(changed);
		byProject.set(project, files);
	}
	const projects: ResolvedTypeScriptProject[] = [];
	const unavailableProjects: ProjectDiagnostics[] = [];
	for (const [project, candidates] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
		const compilerPath = findLocalCompiler(project, gitRoot, exists);
		if (!compilerPath) {
			unavailableProjects.push(unavailableProject(project, candidates, "local TypeScript compiler not found between project and git root"));
			candidates.forEach((file) => uncovered.add(file));
			continue;
		}
		let version: string;
		let ts: TypeScriptApi;
		try {
			version = compilerVersion(compilerPath, readFile);
			ts = await (deps.loadTypeScript ?? defaultLoadTypeScript)(compilerPath);
		} catch (error) {
			unavailableProjects.push(unavailableProject(project, candidates, `local TypeScript compiler unavailable: ${String(error)}`));
			candidates.forEach((file) => uncovered.add(file));
			continue;
		}
		const read = ts.readConfigFile(project, ts.sys.readFile);
		if (read.error || !read.config) {
			const diagnostics = read.error ? configDiagnostics(ts, [read.error], gitRoot) : [];
			const reason = diagnostics[0]?.message ?? "config parse failed";
			unavailableProjects.push(unavailableProject(project, candidates, `unsupported config: ${reason}`, diagnostics));
			candidates.forEach((file) => uncovered.add(file));
			continue;
		}
		const unsupported = unsupportedConfig(read.config);
		if (unsupported) {
			unavailableProjects.push(unavailableProject(project, candidates, unsupported));
			candidates.forEach((file) => uncovered.add(file));
			continue;
		}
		const candidateAbsolute = candidates.map((file) => isAbsolute(file) ? resolve(file) : resolve(gitRoot, file));
		const host = { ...ts.sys, readDirectory: virtualReadDirectory(ts, candidateAbsolute, dirname(project)), onUnRecoverableConfigFileDiagnostic() {} };
		const parsed = ts.parseJsonConfigFileContent(read.config, host, dirname(project), undefined, project);
		const diagnostics = configDiagnostics(ts, parsed.errors, gitRoot);
		if (parsed.errors.some((error) => !EMPTY_INPUT_CONFIG_DIAGNOSTICS.has(error.code))) {
			const reason = diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.message}`).join("\n");
			unavailableProjects.push(unavailableProject(project, candidates, `unsupported config: ${reason}`, diagnostics));
			candidates.forEach((file) => uncovered.add(file));
			continue;
		}
		const included = new Set(parsed.fileNames.map((file) => resolve(file)));
		const covered = candidates.filter((file) => included.has(isAbsolute(file) ? resolve(file) : resolve(gitRoot, file)));
		candidates.filter((file) => !covered.includes(file)).forEach((file) => uncovered.add(file));
		if (covered.length) projects.push({ project, changedFiles: uniqueSorted(covered), compilerPath, compilerVersion: version });
	}
	return {
		gitRoot,
		changedFiles: tsFiles,
		projects,
		unavailableProjects,
		uncoveredFiles: uniqueSorted([...uncovered]),
		hadProjectCandidates: byProject.size > 0,
		reason: !projects.length && !unavailableProjects.length
			? (byProject.size ? "nearest tsconfig.json excludes the changed TypeScript files" : "no nearest tsconfig.json covers the changed TypeScript files")
			: undefined,
	};
}

/** The exact compiler argv used by execution and exposed as evidence. */
export function compilerArgv(project: ResolvedTypeScriptProject, cacheFile: string, nodeExecutable = process.execPath): string[] {
	return [
		nodeExecutable,
		project.compilerPath,
		"--project", project.project,
		"--noEmit",
		"--pretty", "false",
		"--incremental",
		"--tsBuildInfoFile", cacheFile,
	];
}

export const runProcess: ProcessRunner = (file, args, options) => new Promise((finish) => {
	const started = Date.now();
	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;
	let killTimer: NodeJS.Timeout | undefined;
	let settlementTimer: NodeJS.Timeout | undefined;
	const child = spawn(file, args, { cwd: options.cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	const done = (result: Omit<ProcessResult, "stdout" | "stderr" | "durationMs">) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (killTimer) clearTimeout(killTimer);
		if (settlementTimer) clearTimeout(settlementTimer);
		finish({ ...result, stdout, stderr, durationMs: Date.now() - started });
	};
	child.stdout?.on("data", (chunk) => { stdout += chunk; });
	child.stderr?.on("data", (chunk) => { stderr += chunk; });
	child.on("error", (error) => done({ exitCode: null, spawnError: error.message, timedOut }));
	child.on("close", (code) => done({ exitCode: code, timedOut }));
	const timer = setTimeout(() => {
		timedOut = true;
		stderr += `\nTimed out after ${options.timeoutMs}ms`;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), DEFAULT_KILL_GRACE_MS);
		settlementTimer = setTimeout(() => done({ exitCode: null, timedOut: true }), DEFAULT_KILL_GRACE_MS * 2);
	}, Math.max(1, options.timeoutMs));
});

/** Execute one resolved project; spawn, output parsing, and display grouping stay separate. */
export async function runProjectDiagnostics(
	project: ResolvedTypeScriptProject,
	options: DiagnosticsOptions & { gitRoot: string; timeoutMs?: number } = { gitRoot: process.cwd() },
	deps: DiagnosticsDependencies = {},
): Promise<ProjectDiagnostics> {
	let cache: BuildInfoCacheLease;
	try {
		cache = (deps.acquireCache ?? acquireBuildInfoCache)({
			worktree: options.gitRoot,
			project: project.project,
			compilerVersion: project.compilerVersion,
			lane: options.cacheLane,
			runId: options.runId,
			cacheRoot: options.cacheRoot,
		});
	} catch (error) {
		return unavailableProject(project.project, project.changedFiles, `build-info cache unavailable: ${String(error)}`);
	}
	const argv = compilerArgv(project, cache.file, options.nodeExecutable);
	try {
		const execution = await (deps.runProcess ?? runProcess)(argv[0], argv.slice(1), {
			cwd: options.gitRoot,
			timeoutMs: options.timeoutMs ?? options.projectTimeoutMs ?? DEFAULT_PROJECT_TIMEOUT_MS,
		});
		const diagnostics = [
			...parseCompilerOutput(execution.stdout, options.gitRoot),
			...parseCompilerOutput(execution.stderr, options.gitRoot),
		];
		if (execution.timedOut) return {
			project: project.project, status: "unavailable", exitCode: execution.exitCode,
			reason: `compiler timed out after ${options.timeoutMs ?? options.projectTimeoutMs ?? DEFAULT_PROJECT_TIMEOUT_MS}ms`,
			diagnostics, argv, stdout: execution.stdout, stderr: execution.stderr, durationMs: execution.durationMs,
			compilerVersion: project.compilerVersion, changedFiles: project.changedFiles,
		};
		if (execution.spawnError) return {
			project: project.project, status: "unavailable", exitCode: execution.exitCode,
			reason: `compiler spawn failed: ${execution.spawnError}`, diagnostics, argv,
			stdout: execution.stdout, stderr: execution.stderr, durationMs: execution.durationMs,
			compilerVersion: project.compilerVersion, changedFiles: project.changedFiles,
		};
		return {
			project: project.project,
			status: execution.exitCode === 0 ? "passed" : "errors",
			exitCode: execution.exitCode,
			reason: execution.exitCode !== 0 && diagnostics.length === 0 ? "compiler exited nonzero without parseable diagnostics" : undefined,
			diagnostics,
			argv,
			stdout: execution.stdout,
			stderr: execution.stderr,
			durationMs: execution.durationMs,
			compilerVersion: project.compilerVersion,
			changedFiles: project.changedFiles,
		};
	} catch (error) {
		return {
			...unavailableProject(project.project, project.changedFiles, `compiler execution failed: ${String(error)}`),
			argv,
			compilerVersion: project.compilerVersion,
		};
	} finally {
		cache.release();
	}
}

/** Standalone Step 1 entry point. It is intentionally not wired into dispatch yet. */
export async function diagnoseChangedTypeScript(
	changedFiles: readonly string[],
	options: DiagnosticsOptions = {},
	deps: DiagnosticsDependencies = {},
): Promise<DiagnosticsResult> {
	const resolution = await resolveChangedFileProjects(changedFiles, { cwd: options.cwd }, deps);
	const attribution = options.attribution ?? "no_observed_overlap";
	if (!resolution.gitRoot) return {
		status: resolution.changedFiles.length ? "incomplete" : "skipped",
		reason: resolution.reason,
		changedFiles: resolution.changedFiles,
		attribution,
		projects: resolution.unavailableProjects,
		uncoveredFiles: resolution.uncoveredFiles,
	};
	if (!resolution.projects.length && !resolution.unavailableProjects.length) return {
		status: resolution.hadProjectCandidates ? "incomplete" : "skipped",
		reason: resolution.reason,
		changedFiles: resolution.changedFiles,
		attribution,
		projects: [],
		uncoveredFiles: resolution.uncoveredFiles,
	};
	const now = deps.now ?? Date.now;
	const started = now();
	const totalTimeout = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
	const projects = [...resolution.unavailableProjects];
	for (const project of resolution.projects) {
		const remaining = totalTimeout - (now() - started);
		if (remaining <= 0) {
			projects.push(unavailableProject(project.project, project.changedFiles, `total compiler timeout exceeded after ${totalTimeout}ms`));
			continue;
		}
		projects.push(await runProjectDiagnostics(project, {
			...options,
			gitRoot: resolution.gitRoot,
			timeoutMs: Math.min(options.projectTimeoutMs ?? DEFAULT_PROJECT_TIMEOUT_MS, remaining),
		}, deps));
	}
	const incomplete = resolution.uncoveredFiles.length > 0 || projects.some((project) => project.status === "unavailable");
	return {
		status: incomplete ? "incomplete" : "completed",
		reason: incomplete ? "one or more changed TypeScript paths or projects could not be verified" : undefined,
		changedFiles: resolution.changedFiles,
		attribution,
		projects,
		uncoveredFiles: resolution.uncoveredFiles,
	};
}
