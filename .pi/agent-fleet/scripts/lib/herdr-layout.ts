// .pi/agent-fleet/scripts/lib/herdr-layout.ts
//
// Pure logic for one coms peer's launch argv and its pane env file. No pi
// imports, no sockets, no process.exit — everything throws plain Errors so
// callers decide how to die. Testable under node --test; the wiring lives in
// .pi/agent-fleet/scripts/peer-launch.ts (`just fleet peer <name>`) and the
// Hub's herdr_spawn_peer. There are no peer groups: every peer is started on
// its own, and its settings come from flags (PLAN-11-01, decisions D8/D16).

import { resolve as resolvePath } from "node:path";

import type { LayoutNode } from "../../../../.pi/harnesses/lib/herdr-client.ts";
import { DEFAULT_PROJECT, validateProject } from "./team-project.ts";

export type { LayoutNode };

// Safe charset for any value spliced into a command line — peer values come
// from flags or a Hub tool call, so every one is validated.
export const SAFE = /^[A-Za-z0-9._/,-]+$/;

export interface Peer {
	name?: string;
	persona?: string;
	model?: string;
	// Optional runner. Default (absent) is a pi peer via `_peer`, which always
	// loads chrome-devtools-mcp (D17); "claude-code" spawns an interactive Claude
	// Code plus its coms bridge in the pane via `_claude-peer` (model →
	// `claude --model`).
	runner?: string;
	// Optional "true" | "false" (default false). "true" launches the peer with
	// ENFORCED inspection-only tools and lets it declare `read_only: true` in
	// its coms registry entry (PLAN-11-01 decision D3): a pi persona peer routes
	// through `_peer-read-only` (pi `--tools` allowlist + `--no-mcp` +
	// `--coms-read-only`, and no extension at all — D17); a claude-code peer
	// routes through `_claude-peer-read-only`, whose bridge launches the
	// restricted claude. Both siblings keep the positionals of
	// `_peer`/`_claude-peer`.
	read_only?: string;
}

/**
 * Whether a peer asks for a read-only launch. Only the literal strings
 * "true"/"false" are accepted: a typo must not silently launch a writable
 * peer the operator believes is read-only (or the reverse).
 */
export function peerReadOnly(p: Peer, source: string): boolean {
	if (p.read_only === undefined || p.read_only === "false") return false;
	if (p.read_only === "true") return true;
	throw new Error(
		`Invalid read_only for peer "${p.name ?? "(unnamed)"}" (${source}): ${JSON.stringify(p.read_only)} (expected true or false)`,
	);
}

function stripQuotes(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

// Validate a peer's fields and build its launch argv. `just` recipe params are
// POSITIONAL (persona name model project) — bare positional args, never
// key=value. A pi peer is `_peer <persona> <name> [<model>] [<project>]`; a
// claude-code peer is `_claude-peer <name> [<model>] [<project>]`. When the
// project is non-default and the peer has no model, an empty-string
// placeholder keeps the project in its slot. `read_only: "true"` swaps in the
// read-only sibling recipe with the same positionals.
export function peerCommand(p: Peer, project = DEFAULT_PROJECT): string[] {
	validateProject(project);
	if (p.runner !== undefined && p.runner !== "claude-code") {
		throw new Error(`Unknown runner "${p.runner}" for peer "${p.name}" (supported: claude-code).`);
	}
	if (!p.persona && p.runner !== "claude-code") {
		throw new Error(`Peer "${p.name ?? "(unnamed)"}" is missing a persona.`);
	}
	if (!p.name) {
		throw new Error(`Peer with persona "${p.persona}" is missing a name.`);
	}
	for (const [k, v] of Object.entries(p)) {
		if (typeof v === "string" && !SAFE.test(v)) {
			throw new Error(`Unsafe value for ${k} of peer "${p.name}": ${JSON.stringify(v)} (allowed: ${SAFE})`);
		}
	}
	const readOnly = peerReadOnly(p, `peer "${p.name}"`);
	const parts: string[] =
		p.runner === "claude-code"
			? ["just", readOnly ? "_claude-peer-read-only" : "_claude-peer", p.name]
			: ["just", readOnly ? "_peer-read-only" : "_peer", p.persona!, p.name];
	if (p.model) parts.push(p.model);
	if (project !== DEFAULT_PROJECT) {
		if (!p.model) parts.push(""); // keep the project positional aligned
		parts.push(project);
	}
	return parts;
}

// Parse a KEY=VALUE env file (B3): no shell evaluation, no expansion.
// Blank lines and #-comments are skipped; values may be single- or
// double-quoted (quotes stripped, contents taken literally).
export function parseEnvFile(raw: string, sourceName = "env file"): Record<string, string> {
	const env: Record<string, string> = {};
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) {
			throw new Error(`${sourceName}:${i + 1}: not a KEY=VALUE line: ${JSON.stringify(line)}`);
		}
		env[m[1]] = stripQuotes(m[2].trim());
	}
	return env;
}

// Resolve a peer's env file (`--env-file`) to an absolute path inside the
// repo. The SAFE charset excludes shell metacharacters; this adds the
// traversal guard: repo-relative, no escaping the repo root.
export function resolveEnvFilePath(envFile: string, repoRoot: string): string {
	if (!SAFE.test(envFile)) {
		throw new Error(`Unsafe env_file path: ${JSON.stringify(envFile)} (allowed: ${SAFE})`);
	}
	if (envFile.startsWith("/")) {
		throw new Error(`env_file must be repo-relative, got absolute path: ${envFile}`);
	}
	const abs = resolvePath(repoRoot, envFile);
	if (abs !== repoRoot && !abs.startsWith(repoRoot + "/")) {
		throw new Error(`env_file escapes the repo root: ${envFile}`);
	}
	return abs;
}
