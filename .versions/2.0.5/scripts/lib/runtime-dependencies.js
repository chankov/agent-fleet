// Shared runtime dependency health check for lifecycle diagnostics and launchers.
// Keep this module plain JavaScript with builtin-only imports: the launcher must
// be able to load it precisely when the workspace's npm dependencies are broken.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export const RUNTIME_DEPENDENCY_ROOTS = Object.freeze([
	Object.freeze({ root: ".pi/extensions", label: "Pi extensions" }),
	Object.freeze({ root: ".pi/harnesses", label: "Pi harnesses" }),
	Object.freeze({ root: "scripts", label: "workflow runtime" }),
]);

export const RUNTIME_DEPENDENCY_REMEDIATION =
	"run `just fleet deps`, or rerun setup with `just fleet setup --allow-exec`, then retry";

function parsePackage(file) {
	try {
		return { value: JSON.parse(readFileSync(file, "utf8")), error: null };
	} catch (error) {
		return { value: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function compactProblems(stdout, workspace) {
	try {
		const parsed = JSON.parse(stdout || "{}");
		if (!Array.isArray(parsed.problems) || parsed.problems.length === 0) return null;
		return parsed.problems
			.slice(0, 3)
			.map((problem) => String(problem).replaceAll(workspace, "."))
			.join("; ");
	} catch {
		return null;
	}
}

/**
 * Check every installed Agent Fleet npm root with `npm ls`.
 * A root without package.json was not selected/installed and is skipped.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {typeof nodeSpawnSync} [opts.run]
 * @returns {{healthy: boolean, checks: Array<object>, failures: Array<object>}}
 */
export function checkRuntimeDependencies({ workspace, run = nodeSpawnSync } = {}) {
	if (!workspace) throw new Error("runtime dependency check requires a workspace");
	const checks = [];

	for (const spec of RUNTIME_DEPENDENCY_ROOTS) {
		const packagePath = join(workspace, spec.root, "package.json");
		if (!existsSync(packagePath)) continue;

		const parsedPackage = parsePackage(packagePath);
		const nodeModulesPath = join(spec.root, "node_modules");
		if (parsedPackage.error) {
			checks.push({
				...spec,
				path: `${spec.root}/package.json`,
				healthy: false,
				reason: `package.json is unreadable: ${parsedPackage.error}`,
			});
			continue;
		}

		const dependencies = Object.keys(parsedPackage.value?.dependencies ?? {});
		const args = ["ls", "--prefix", spec.root, "--depth=0", "--json"];
		const result = run("npm", args, {
			cwd: workspace,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 30_000,
		});
		const missingRoot = dependencies.length > 0 && !existsSync(join(workspace, nodeModulesPath));
		const problems = compactProblems(result.stdout, workspace);
		const healthy = !result.error && result.status === 0 && !missingRoot;
		let reason = null;
		if (result.error) reason = `could not run npm ls: ${result.error.message}`;
		else if (missingRoot) reason = `${nodeModulesPath} is missing`;
		else if (problems) reason = problems;
		else if (result.status !== 0) reason = `npm ls exited ${result.status ?? "without a status"}`;

		checks.push({
			...spec,
			path: nodeModulesPath,
			healthy,
			dependencies,
			command: `npm ${args.join(" ")}`,
			...(reason ? { reason } : {}),
		});
	}

	const failures = checks.filter((check) => !check.healthy);
	return { healthy: failures.length === 0, checks, failures };
}

/** Doctor-shaped findings for every unhealthy installed dependency root. */
export function runtimeDependencyFindings({ workspace, run } = {}) {
	return checkRuntimeDependencies({ workspace, run }).failures.map((failure) => ({
		type: "runtime-dependencies",
		path: failure.path,
		issue: `${failure.label} dependencies are incomplete — ${failure.reason}`,
		fix: RUNTIME_DEPENDENCY_REMEDIATION,
		root: failure.root,
		...(failure.command ? { check: failure.command } : {}),
	}));
}

/** Fail a launcher before Pi imports an incomplete Agent Fleet runtime. */
export function assertRuntimeDependencies(workspace, options = {}) {
	const report = checkRuntimeDependencies({ workspace, ...options });
	if (report.healthy) return report;
	const details = report.failures.map((failure) => `  - ${failure.root}: ${failure.reason}`).join("\n");
	const error = new Error(
		`Agent Fleet runtime dependencies are incomplete:\n${details}\n` +
		`Remediation: ${RUNTIME_DEPENDENCY_REMEDIATION}.\n` +
		"This preflight stopped before Pi startup so extension-load failures are not misreported as unknown flags.",
	);
	error.name = "RuntimeDependencyError";
	error.report = report;
	throw error;
}
