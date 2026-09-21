import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const SCOUT_DATA_ROOT_ENV = "AGENT_FLEET_SCOUT_DATA_ROOT";
const FILESYSTEM_TOOLS = new Set(["read", "grep", "find", "ls"]);

function hasTraversal(value: string): boolean {
	return value.replaceAll("\\", "/").split("/").includes("..");
}

function inside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** Validate model-declared filesystem data paths without restricting runtime/library reads. */
export function validateScoutDataPath(rootValue: string, cwdValue: string, inputValue: unknown): string | null {
	if (typeof inputValue !== "string" || inputValue.includes("\0")) return "Scout filesystem path must be a plain string.";
	if (hasTraversal(inputValue)) return "Scout filesystem traversal is denied.";
	const root = realpathSync(resolve(rootValue));
	// Canonicalize cwd too: Darwin tmpdir aliases (/var vs /private/var) would
	// otherwise make every in-snapshot read look like an escape.
	const cwd = realpathSync(resolve(cwdValue));
	const candidate = resolve(cwd, inputValue || ".");
	if (!inside(root, candidate)) return "Scout filesystem reads are limited to the isolated snapshot.";
	let current = root;
	const fromRoot = relative(root, candidate);
	for (const part of fromRoot ? fromRoot.split(sep) : []) {
		current = resolve(current, part);
		if (!existsSync(current)) break;
		if (lstatSync(current).isSymbolicLink()) return "Scout filesystem symlink traversal is denied.";
	}
	if (existsSync(candidate) && !inside(root, realpathSync(candidate))) return "Scout filesystem symlink escape is denied.";
	return null;
}

function validatePattern(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string" || value.includes("\0") || isAbsolute(value) || hasTraversal(value)) return "Scout filesystem pattern traversal is denied.";
	return null;
}

export default function scoutDataBoundary(pi: { on(name: "tool_call", handler: (event: { toolName?: string; input: unknown }, ctx: { cwd: string }) => unknown): void }): void {
	pi.on("tool_call", (event, ctx) => {
		const tool = String(event.toolName ?? "").toLowerCase();
		if (!FILESYSTEM_TOOLS.has(tool)) return;
		const root = process.env[SCOUT_DATA_ROOT_ENV];
		if (!root) return { block: true, reason: "Scout filesystem boundary is unavailable." };
		const input = event.input as Record<string, unknown>;
		const reason = validateScoutDataPath(root, ctx.cwd, tool === "read" ? input.path : (input.path ?? "."))
			?? (tool === "grep" ? validatePattern(input.glob) : null)
			?? (tool === "find" ? validatePattern(input.pattern) : null);
		return reason ? { block: true, reason } : { block: false };
	});
}
