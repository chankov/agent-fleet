import { spawnSync } from "node:child_process";
import { accessSync, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { constants } from "node:fs";

export type WriteIsolationBackend = "auto" | "bubblewrap" | "seatbelt" | "missing";

export interface WriteIsolationRequest {
	enabled?: boolean;
	platform?: NodeJS.Platform;
	backend?: WriteIsolationBackend;
	backendPath?: string;
	cwd?: string;
	allowlist?: string[];
	runtimePaths?: string[];
	artifactPaths?: string[];
	tempPaths?: string[];
	command?: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface WriteIsolationPolicy {
	mechanism: "bubblewrap" | "seatbelt";
	wholeProcessIncludingDescendants: true;
	damageControlRole: "overlay";
	directWritesOnly: true;
	permissionExpansion: false;
	rollsBackUserEdits: false;
	protectsConcurrentUserWrites: false;
}

export interface WriteIsolationResult extends WriteIsolationPolicy {
	applied: boolean;
	failClosed: boolean;
	reason?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	seatbeltProfile?: string;
	writableFiles?: string[];
	writableDirectories?: string[];
}

const GLOB_META = /[*?\[\]{}!]/;

export function policyFor(input: Pick<WriteIsolationRequest, "platform" | "allowlist" | "runtimePaths" | "artifactPaths" | "tempPaths"> = {}): WriteIsolationPolicy {
	const platform = input.platform ?? process.platform;
	return {
		mechanism: platform === "darwin" ? "seatbelt" : "bubblewrap",
		wholeProcessIncludingDescendants: true,
		damageControlRole: "overlay",
		directWritesOnly: true,
		permissionExpansion: false,
		rollsBackUserEdits: false,
		protectsConcurrentUserWrites: false,
	};
}

function findExecutable(name: string): string | undefined {
	for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = resolve(directory, name);
		try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
	}
	return undefined;
}

/** True only when bwrap can actually create a user namespace, not merely when the binary exists. */
export function linuxUserNamespaceSandboxAvailable(): boolean {
	if (process.platform !== "linux") return false;
	const backendPath = findExecutable("bwrap");
	if (!backendPath) return false;
	const probe = spawnSync(backendPath, ["--die-with-parent", "--ro-bind", "/", "/", "--", "true"], { encoding: "utf8", timeout: 5_000 });
	return probe.status === 0;
}

function quoteSeatbelt(value: string): string {
	return `\"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}\"`;
}

function canonicalTrustedPath(path: string): string {
	return realpathSync(resolve(path));
}

function strictUserGrantPath(path: string): string {
	const absolute = resolve(path);
	const canonical = canonicalTrustedPath(absolute);
	if (canonical !== absolute || lstatSync(absolute).isSymbolicLink()) throw new Error(`symlink path is unsupported in enforced write isolation: ${path}`);
	return absolute;
}

function resolveApprovedPaths(input: WriteIsolationRequest): { files: string[]; directories: string[] } {
	// The runtime owns cwd/support paths, so canonical aliases such as Darwin's
	// /tmp -> /private/tmp and /var -> /private/var are safe to normalize. User
	// scope grants remain strict below and may not contain any symlink alias.
	const cwd = canonicalTrustedPath(input.cwd ?? process.cwd());
	const files: string[] = [];
	const directories: string[] = [];
	for (const rawValue of input.allowlist ?? []) {
		const raw = String(rawValue).trim();
		if (!raw) continue;
		if (isAbsolute(raw)) throw new Error(`write allowlist paths must be relative to the dispatch cwd: ${raw}`);
		if (GLOB_META.test(raw)) throw new Error(`glob scope is unsupported in enforced write isolation: ${raw}`);
		const candidate = resolve(cwd, raw);
		const fromRoot = relative(cwd, candidate);
		if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot))
			throw new Error(`write allowlist path escapes the dispatch cwd: ${raw}`);
		let canonical: string;
		try { canonical = strictUserGrantPath(candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`exact writable files must already exist; create new files only inside an expressly allowed existing directory: ${raw}`);
			throw error;
		}
		if (statSync(canonical).isDirectory()) directories.push(canonical);
		else if (raw.endsWith("/") || raw.endsWith("\\")) throw new Error(`recursive writable directory is not a directory: ${raw}`);
		else files.push(canonical);
	}
	for (const raw of [...(input.runtimePaths ?? []), ...(input.artifactPaths ?? []), ...(input.tempPaths ?? [])]) {
		const candidate = isAbsolute(raw) ? raw : resolve(cwd, raw);
		const canonical = canonicalTrustedPath(candidate);
		if (statSync(canonical).isDirectory()) directories.push(canonical);
		else files.push(canonical);
	}
	return { files: [...new Set(files)], directories: [...new Set(directories)] };
}

function seatbeltProfile(files: string[], directories: string[]): string {
	const grants = [
		...files.map(path => `(literal ${quoteSeatbelt(path)})`),
		...directories.flatMap(path => [`(literal ${quoteSeatbelt(path)})`, `(subpath ${quoteSeatbelt(path)})`]),
		// Ordinary stdio/redirection needs these device nodes. Keep them literal:
		// a blanket /dev grant would create an unrelated write surface.
		`(literal ${quoteSeatbelt("/dev/null")})`,
		`(literal ${quoteSeatbelt("/dev/tty")})`,
	];
	const exception = grants.length === 1 ? grants[0] : `(require-any\n      ${grants.join("\n      ")})`;
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*",
		`  (require-not ${exception}))`,
	].join("\n");
}

export function confineNativeChild(input: WriteIsolationRequest): WriteIsolationResult {
	const base = policyFor(input);
	const command = input.command ?? "pi";
	const originalArgs = [...(input.args ?? [])];
	const cwd = resolve(input.cwd ?? process.cwd());
	if (input.enabled !== true) return { ...base, applied: false, failClosed: false, command, args: originalArgs, cwd, env: input.env };

	const platform = input.platform ?? process.platform;
	const expected = platform === "darwin" ? "seatbelt" : platform === "linux" ? "bubblewrap" : null;
	const selected = input.backend && input.backend !== "auto" ? input.backend : expected;
	if (!expected || selected === "missing") return { ...base, applied: false, failClosed: true, reason: `native write-isolation backend unavailable for ${platform}`, cwd };
	if (selected !== expected) return { ...base, applied: false, failClosed: true, reason: `${selected} is not the native write-isolation backend for ${platform}`, cwd };

	let approved: { files: string[]; directories: string[] };
	try { approved = resolveApprovedPaths(input); }
	catch (error) { return { ...base, applied: false, failClosed: true, reason: error instanceof Error ? error.message : String(error), cwd }; }
	if (approved.files.length === 0 && approved.directories.length === 0)
		return { ...base, applied: false, failClosed: true, reason: "no approved writable paths; refusing sandbox launch with an empty grant set", cwd };

	const backendPath = input.backendPath ?? findExecutable(selected === "bubblewrap" ? "bwrap" : "sandbox-exec");
	if (!backendPath) return { ...base, applied: false, failClosed: true, reason: `${selected} backend unavailable; refusing unsandboxed execution`, cwd };
	if (selected === "bubblewrap") {
		const deviceArgs = ["/dev/null", "/dev/tty"].filter(path => { try { accessSync(path); return true; } catch { return false; } }).flatMap(path => ["--dev-bind", path, path]);
		const binds = [
			...approved.directories.flatMap(path => ["--bind", path, path]),
			...approved.files.flatMap(path => ["--bind", path, path]),
		];
		return {
			...base, applied: true, failClosed: true, command: backendPath,
			// Do not use bwrap --new-session: the Hub deliberately owns one detached
			// process group so its existing cancellation cascade reaches descendants.
			args: ["--die-with-parent", "--ro-bind", "/", "/", ...deviceArgs, ...binds, "--chdir", cwd, "--", command, ...originalArgs],
			cwd, env: input.env, writableFiles: approved.files, writableDirectories: approved.directories,
		};
	}
	const profile = seatbeltProfile(approved.files, approved.directories);
	return {
		...base, applied: true, failClosed: true, command: backendPath,
		args: ["-p", profile, "--", command, ...originalArgs], cwd, env: input.env,
		seatbeltProfile: profile, writableFiles: approved.files, writableDirectories: approved.directories,
	};
}
