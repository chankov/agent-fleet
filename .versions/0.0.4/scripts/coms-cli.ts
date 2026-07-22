// scripts/coms-cli.ts
//
// Envelope-protocol CLI for non-pi participants in a coms pool. Registry and
// spool paths are always scoped by a validated project and caller name.
//
// usage: coms-cli <list|send|await|reply> [args] --project <p> --name <me>

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	bindEndpoint,
	COMS_DIR,
	ensureComsDirs,
	isPromptEnvelope,
	isResponseEnvelope,
	makeConnHandler,
	makeEndpoint,
	makePromptEnvelope,
	makeResponseEnvelope,
	nowIso,
	pruneDeadEntries,
	removeRegistryEntry,
	sendEnvelope,
	ulid,
	validateComsName,
	validateComsProject,
	writeAck,
	writeNack,
	writeRegistryAtomic,
	type RegistryEntry,
	type SenderIdentity,
} from "./lib/coms-envelope.ts";

const DEFAULT_NAME = "claude-cli";
const DEFAULT_PROJECT = "default";
const DEFAULT_AWAIT_MS = 300_000;
const MAX_TIMEOUT_MS = 0x7fffffff;
const COMS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type FlagName = "project" | "name" | "await" | "timeout" | "all" | "conductor" | "session" | "ttl";

interface ParsedArgs {
	positionals: string[];
	flags: Map<FlagName, string | true>;
}

interface Scope {
	project: string;
	name: string;
	includeExplicit: boolean;
}

interface CodexLock {
	release(): void;
}

function fail(message: string): never {
	throw new Error(message);
}

function parseArgs(argv: string[], allowed: readonly FlagName[]): ParsedArgs {
	const allowedFlags = new Set<FlagName>(allowed);
	const flags = new Map<FlagName, string | true>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const flag = arg.slice(2) as FlagName;
		if (!allowedFlags.has(flag)) fail(`unknown flag: ${arg}`);
		if (flags.has(flag)) fail(`--${flag} may only be provided once`);
		if (flag === "await" || flag === "all") {
			flags.set(flag, true);
			continue;
		}
		const value = argv[i + 1];
		if (!value || value.startsWith("--")) fail(`--${flag} requires a value`);
		flags.set(flag, value);
		i++;
	}
	return { positionals, flags };
}

function flagValue(parsed: ParsedArgs, flag: FlagName): string | undefined {
	const value = parsed.flags.get(flag);
	return typeof value === "string" ? value : undefined;
}

function scopeFrom(parsed: ParsedArgs): Scope {
	const project = validateComsProject(flagValue(parsed, "project") ?? process.env.COMS_CLI_PROJECT ?? DEFAULT_PROJECT);
	const name = validateComsName(flagValue(parsed, "name") ?? process.env.COMS_CLI_NAME ?? DEFAULT_NAME);
	return { project, name, includeExplicit: parsed.flags.get("all") === true };
}

function timeoutFrom(parsed: ParsedArgs, flag: "timeout" | "ttl" = "timeout"): number {
	const raw = flagValue(parsed, flag) ?? process.env.PI_COMS_TIMEOUT_MS ?? String(DEFAULT_AWAIT_MS);
	if (!/^\d+$/.test(raw)) fail(`Invalid timeout: ${JSON.stringify(raw)} (use a positive integer no greater than ${MAX_TIMEOUT_MS})`);
	const timeoutMs = Number(raw);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		fail(`Invalid timeout: ${JSON.stringify(raw)} (use a positive integer no greater than ${MAX_TIMEOUT_MS})`);
	}
	return timeoutMs;
}

function validateComsId(value: string, label: "msg_id" | "listen session"): string {
	if (!COMS_ID_RE.test(value)) fail(`Invalid ${label}: ${JSON.stringify(value)} (expected a 26-character Crockford ULID)`);
	return value;
}

function spoolDir(project: string, name: string): string {
	return path.join(COMS_DIR, "cli", "projects", validateComsProject(project), validateComsName(name));
}

function legacySpoolDir(name: string): string {
	return path.join(COMS_DIR, "cli", validateComsName(name));
}

function ensureSpool(project: string, name: string): { pending: string; responses: string; inbound: string } {
	const base = spoolDir(project, name);
	const legacy = legacySpoolDir(name);
	// A legacy name-only queue cannot be assigned to a project safely. Refuse
	// rather than consuming it under whichever project happens to run first.
	if (fs.existsSync(legacy)) {
		fail(`Legacy name-only coms spool exists at ${legacy}; stop that identity, inspect the queue, and move the complete directory under cli/projects/<project>/<name> after confirming its project. Do not delete ambiguous pending data.`);
	}
	const dirs = {
		pending: path.join(base, "pending"),
		responses: path.join(base, "responses"),
		inbound: path.join(base, "inbound"),
	};
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dirs;
}

function peersInScope(scope: Scope): RegistryEntry[] {
	return pruneDeadEntries(scope.project).filter(
		(entry) => entry.name !== scope.name && (scope.includeExplicit || !entry.explicit),
	);
}

function makeIdentity(name: string, sessionId: string): SenderIdentity {
	return { session_id: sessionId, name, endpoint: makeEndpoint(sessionId), cwd: process.cwd() };
}

function registerCliEntry(id: SenderIdentity, project: string, purpose: string): void {
	const entry: RegistryEntry = {
		session_id: id.session_id,
		name: id.name,
		purpose,
		model: "cli",
		color: "#FEDE5D",
		pid: process.pid,
		endpoint: id.endpoint,
		cwd: id.cwd,
		started_at: nowIso(),
		explicit: true,
		version: 1,
	};
	writeRegistryAtomic(entry, project);
}

function acquireCodexLock(scope: Scope): CodexLock {
	const lockDir = path.join(COMS_DIR, "locks");
	const lockPath = path.join(lockDir, "codex-send.lock");
	fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(lockDir, 0o700); } catch { /* best effort */ }
	let fd: number;
	try {
		fd = fs.openSync(lockPath, "wx", 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			fail(`Codex send lock is held (or stale) at ${lockPath}; inspect its metadata and remove it manually only after confirming the owner is gone.`);
		}
		throw err;
	}
	try {
		fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at: nowIso(), project: scope.project, name: scope.name })}\n`);
	} finally {
		fs.closeSync(fd);
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		process.removeListener("SIGTERM", onSigterm);
		process.removeListener("SIGINT", onSigint);
		try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
	};
	const exitForSignal = (signal: NodeJS.Signals) => {
		release();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	const onSigterm = () => exitForSignal("SIGTERM");
	const onSigint = () => exitForSignal("SIGINT");
	process.once("SIGTERM", onSigterm);
	process.once("SIGINT", onSigint);
	return { release };
}

// ━━ list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdList(argv: string[]): void {
	const parsed = parseArgs(argv, ["project", "name", "all"]);
	if (parsed.positionals.length > 0) fail("list does not accept positional arguments");
	const scope = scopeFrom(parsed);
	const peers = peersInScope(scope);
	if (peers.length === 0) {
		console.log(`(no live peers in project "${scope.project}")`);
		return;
	}
	for (const peer of peers) console.log(`${peer.name}\t${peer.model}\t${peer.purpose}`);
}

// ━━ send ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function validateCodexMode(parsed: ParsedArgs): boolean {
	const conductor = flagValue(parsed, "conductor");
	if (conductor === undefined) return false;
	if (conductor !== "codex") fail(`Unsupported conductor: ${JSON.stringify(conductor)}`);
	if (!parsed.flags.has("project") || !parsed.flags.has("name") || !parsed.flags.has("timeout") || parsed.flags.get("await") !== true) {
		fail("Codex mode requires explicit --project, --name, --await, and --timeout options.");
	}
	if (parsed.flags.get("all") === true) fail("Codex mode does not allow --all.");
	return true;
}

async function cmdSend(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv, ["project", "name", "await", "timeout", "all", "conductor"]);
	const [rawTarget, ...promptParts] = parsed.positionals;
	const prompt = promptParts.join(" ");
	if (!rawTarget || !prompt) fail("usage: coms-cli send <peer> <prompt…> --project <project> --name <name> [--await] [--timeout <ms>]");
	const target = validateComsName(rawTarget);
	const scope = scopeFrom(parsed);
	const timeoutMs = timeoutFrom(parsed);
	const codexMode = validateCodexMode(parsed);
	const lock = codexMode ? acquireCodexLock(scope) : null;
	try {
		// This fresh scoped list is both the only target source and, for Codex,
		// intentionally happens after lock acquisition.
		const peers = peersInScope(scope);
		const peer = peers.find((entry) => entry.name === target);
		if (!peer) {
			const names = peers.map((entry) => entry.name).join(", ") || "(none)";
			fail(`Peer "${target}" not found in project "${scope.project}". Live peers: ${names}`);
		}

		ensureComsDirs(scope.project);
		const spool = ensureSpool(scope.project, scope.name);
		const doAwait = parsed.flags.get("await") === true;
		if (doAwait) {
			const id = makeIdentity(scope.name, ulid());
			let resolveReply!: (value: { response: unknown; error?: string | null }) => void;
			const reply = new Promise<{ response: unknown; error?: string | null }>((resolve) => { resolveReply = resolve; });
			const server = await bindEndpoint(
				id.endpoint,
				makeConnHandler((env, socket) => {
					if (isResponseEnvelope(env)) {
						writeAck(socket, env.msg_id);
						resolveReply({ response: env.response, error: env.error ?? null });
					} else if ((env as { type?: string }).type === "ping") {
						writeAck(socket, (env as { msg_id?: string }).msg_id ?? "");
					} else {
						writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "cli awaits responses only");
					}
				}),
			);
			registerCliEntry(id, scope.project, `coms-cli (one-shot ask from ${scope.name})`);
			const cleanup = () => {
				try { server.close(); } catch { /* ignore */ }
				try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
				removeRegistryEntry(scope.project, id.name);
			};
			try {
				const env = makePromptEnvelope(id, prompt);
				await sendEnvelope(peer.endpoint, env);
				console.error(`sent ${env.msg_id} → ${peer.name} (awaiting reply, timeout ${timeoutMs}ms)`);
				let timeoutTimer!: NodeJS.Timeout;
				const timeout = new Promise<never>((_resolve, reject) => {
					timeoutTimer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
				});
				const result = await Promise.race([reply, timeout]).finally(() => clearTimeout(timeoutTimer));
				if (result.error) fail(`peer error: ${result.error}`);
				console.log(typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2));
			} finally {
				cleanup();
			}
			return;
		}

		const sessionId = ulid();
		const endpoint = makeEndpoint(sessionId);
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(import.meta.url),
				"_listen",
				"--name", scope.name,
				"--project", scope.project,
				"--session", sessionId,
				"--ttl", String(timeoutMs),
			],
			{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const timer = setTimeout(() => finish(() => reject(new Error("waiter did not become ready"))), 5_000);
			child.stdout!.on("data", (data) => {
				if (data.toString().includes("READY")) finish(resolve);
			});
			child.once("exit", () => finish(() => reject(new Error("waiter exited early"))));
		});
		child.unref();
		child.stdout!.destroy();

		const id: SenderIdentity = { session_id: sessionId, name: scope.name, endpoint, cwd: process.cwd() };
		const env = makePromptEnvelope(id, prompt);
		const pendingFile = path.join(spool.pending, `${env.msg_id}.json`);
		fs.writeFileSync(pendingFile, JSON.stringify({ msg_id: env.msg_id, target: peer.name, sent_at: nowIso() }));
		try {
			await sendEnvelope(peer.endpoint, env);
		} catch (err) {
			try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
			try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
			fail(`send failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		console.log(env.msg_id);
	} finally {
		lock?.release();
	}
}

// ━━ _listen (internal detached waiter) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdListen(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv, ["project", "name", "session", "ttl"]);
	if (parsed.positionals.length > 0) fail("_listen does not accept positional arguments");
	const scope = scopeFrom(parsed);
	const sessionId = validateComsId(flagValue(parsed, "session") ?? ulid(), "listen session");
	const ttl = timeoutFrom(parsed, "ttl");
	ensureComsDirs(scope.project);
	const spool = ensureSpool(scope.project, scope.name);
	const id = makeIdentity(scope.name, sessionId);

	const server = await bindEndpoint(
		id.endpoint,
		makeConnHandler((env, socket) => {
			if (isResponseEnvelope(env) && typeof env.msg_id === "string" && COMS_ID_RE.test(env.msg_id)) {
				writeAck(socket, env.msg_id);
				fs.writeFileSync(
					path.join(spool.responses, `${env.msg_id}.json`),
					JSON.stringify({ response: env.response, error: env.error ?? null, received_at: nowIso() }),
				);
				try { fs.unlinkSync(path.join(spool.pending, `${env.msg_id}.json`)); } catch { /* ignore */ }
				maybeExit();
			} else if (isPromptEnvelope(env) && typeof env.msg_id === "string" && COMS_ID_RE.test(env.msg_id)) {
				writeAck(socket, env.msg_id);
				fs.writeFileSync(
					path.join(spool.inbound, `${env.msg_id}.json`),
					JSON.stringify({
						msg_id: env.msg_id,
						prompt: env.prompt,
						sender_name: env.sender_name,
						sender_endpoint: env.sender_endpoint,
						sender_session: env.sender_session,
						hops: env.hops,
						received_at: nowIso(),
					}),
				);
			} else if ((env as { type?: string }).type === "ping") {
				writeAck(socket, (env as { msg_id?: string }).msg_id ?? "");
			} else {
				writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "unsupported envelope or msg_id");
			}
		}),
	);
	registerCliEntry(id, scope.project, "coms-cli reply waiter");
	console.log("READY");

	const cleanup = () => {
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
		removeRegistryEntry(scope.project, id.name);
		process.exit(0);
	};
	const startedAt = Date.now();
	function maybeExit(): void {
		try {
			const pendingLeft = fs.readdirSync(spool.pending).length;
			if (pendingLeft === 0 && Date.now() - startedAt > 3_000) cleanup();
		} catch {
			// Best-effort cleanup only; the TTL remains authoritative.
		}
	}
	setInterval(maybeExit, 5_000);
	setTimeout(cleanup, ttl);
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
}

// ━━ await ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdAwait(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv, ["project", "name", "timeout"]);
	if (parsed.positionals.length !== 1) fail("usage: coms-cli await <msg_id> --project <project> --name <name> [--timeout <ms>]");
	const msgId = validateComsId(parsed.positionals[0], "msg_id");
	const scope = scopeFrom(parsed);
	const timeoutMs = timeoutFrom(parsed);
	const spool = ensureSpool(scope.project, scope.name);
	const file = path.join(spool.responses, `${msgId}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			const record = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (record.error) fail(`peer error: ${record.error}`);
			console.log(typeof record.response === "string" ? record.response : JSON.stringify(record.response, null, 2));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	fail(`timeout: no reply for ${msgId} after ${timeoutMs}ms`);
}

// ━━ reply ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdReply(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv, ["project", "name"]);
	const [rawMsgId, ...textParts] = parsed.positionals;
	const msgId = rawMsgId ? validateComsId(rawMsgId, "msg_id") : undefined;
	const scope = scopeFrom(parsed);
	let text = textParts.join(" ");
	if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, "utf-8").trim();
	if (!msgId || !text) fail("usage: coms-cli reply <msg_id> <text…> --project <project> --name <name>   (or pipe the text on stdin)");
	const spool = ensureSpool(scope.project, scope.name);
	const recordFile = path.join(spool.inbound, `${msgId}.json`);
	if (!fs.existsSync(recordFile)) fail(`No inbound prompt ${msgId} in ${spool.inbound}`);
	const record = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
	const id = makeIdentity(scope.name, ulid());
	await sendEnvelope(record.sender_endpoint, makeResponseEnvelope(id, msgId, text));
	fs.unlinkSync(recordFile);
	console.log(`replied to ${record.sender_name ?? record.sender_session} (${msgId})`);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "list":
			cmdList(rest);
			return;
		case "send":
			await cmdSend(rest);
			return;
		case "await":
			await cmdAwait(rest);
			return;
		case "reply":
			await cmdReply(rest);
			return;
		case "_listen":
			await cmdListen(rest);
			return;
		default:
			fail("usage: coms-cli <list|send|await|reply> …");
	}
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	void main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
