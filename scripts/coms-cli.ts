// scripts/coms-cli.ts
//
// Envelope-protocol CLI: lets a NON-pi process (a plain shell, Claude Code
// via the peer-coms skill) participate in the coms pool. Speaks the exact
// coms wire protocol (scripts/lib/coms-envelope.ts) over the existing
// registry + unix sockets.
//
//   list                      — live peers in scope (name, model, purpose)
//   send <peer> <prompt>      — send a prompt; prints the msg_id and returns
//                               (a detached waiter holds the reply socket);
//                               --await blocks and prints the reply instead
//   await <msg_id>            — block until the reply for msg_id arrives
//   reply <msg_id> <text>     — answer an inbound prompt (bridge/hook use)
//
// Identity: each invocation acts as peer `--name` (default "claude-cli"),
// registered EXPLICIT — visible to nobody's pool widget, addressable only by
// exact name — and read-only toward the registry except its own entry.
//
// usage: coms-cli <list|send|await|reply> [args] [--project <p>] [--name <me>]
//        [--await] [--timeout <ms>] [--all]

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
	writeAck,
	writeNack,
	writeRegistryAtomic,
	type RegistryEntry,
	type SenderIdentity,
} from "./lib/coms-envelope.ts";

const DEFAULT_NAME = process.env.COMS_CLI_NAME || "claude-cli";
const DEFAULT_AWAIT_MS = 300_000;

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function spoolDir(name: string): string {
	return path.join(COMS_DIR, "cli", name);
}

function ensureSpool(name: string): { pending: string; responses: string; inbound: string } {
	const base = spoolDir(name);
	const dirs = {
		pending: path.join(base, "pending"),
		responses: path.join(base, "responses"),
		inbound: path.join(base, "inbound"),
	};
	for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
	return dirs;
}

interface Scope {
	project: string;
	includeExplicit: boolean;
}

function scopeFrom(argv: string[]): Scope {
	return { project: flagValue(argv, "--project") ?? "default", includeExplicit: argv.includes("--all") };
}

function peersInScope(scope: Scope, selfName: string): RegistryEntry[] {
	return pruneDeadEntries(scope.project).filter(
		(e) => e.name !== selfName && (scope.includeExplicit || !e.explicit),
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

// ━━ list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdList(argv: string[]): void {
	const scope = scopeFrom(argv);
	const name = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const peers = peersInScope(scope, name);
	if (peers.length === 0) {
		console.log(`(no live peers in project "${scope.project}")`);
		return;
	}
	for (const p of peers) {
		console.log(`${p.name}\t${p.model}\t${p.purpose}`);
	}
}

// ━━ send ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdSend(argv: string[]): Promise<void> {
	const positional = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
	const [target, ...promptParts] = positional;
	const prompt = promptParts.join(" ");
	if (!target || !prompt) die("usage: coms-cli send <peer> <prompt…> [--await] [--timeout <ms>]");

	const scope = scopeFrom(argv);
	const name = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const timeoutMs = Number(flagValue(argv, "--timeout") ?? DEFAULT_AWAIT_MS);
	const doAwait = argv.includes("--await");

	const peer = peersInScope(scope, name).find((e) => e.name === target)
		?? pruneDeadEntries(scope.project).find((e) => e.name === target && e.name !== name);
	if (!peer) {
		const names = peersInScope(scope, name).map((e) => e.name).join(", ") || "(none)";
		die(`Peer "${target}" not found in project "${scope.project}". Live peers: ${names}`);
	}

	ensureComsDirs(scope.project);
	const spool = ensureSpool(name);

	if (doAwait) {
		// One process does the whole round trip: bind → register → send → wait.
		const id = makeIdentity(name, ulid());
		let done: (v: { response: unknown; error?: string | null }) => void;
		const reply = new Promise<{ response: unknown; error?: string | null }>((res) => (done = res));
		const server = await bindEndpoint(
			id.endpoint,
			makeConnHandler((env, socket) => {
				if (isResponseEnvelope(env)) {
					writeAck(socket, env.msg_id);
					done({ response: env.response, error: env.error ?? null });
				} else if ((env as { type?: string }).type === "ping") {
					writeAck(socket, (env as { msg_id?: string }).msg_id ?? "");
				} else {
					writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "cli awaits responses only");
				}
			}),
		);
		registerCliEntry(id, scope.project, `coms-cli (one-shot ask from ${name})`);
		const cleanup = () => {
			try { server.close(); } catch { /* ignore */ }
			try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
			removeRegistryEntry(scope.project, id.name);
		};
		try {
			const env = makePromptEnvelope(id, prompt);
			await sendEnvelope(peer.endpoint, env);
			console.error(`sent ${env.msg_id} → ${peer.name} (awaiting reply, timeout ${timeoutMs}ms)`);
			const result = await Promise.race([
				reply,
				new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
			]);
			if (result.error) die(`peer error: ${result.error}`);
			console.log(typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2));
		} finally {
			cleanup();
		}
		return;
	}

	// Detached mode: a waiter child owns the reply socket + registry entry;
	// this process sends, prints the msg_id, and exits.
	const sessionId = ulid();
	const endpoint = makeEndpoint(sessionId);
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(import.meta.url),
			"_listen",
			"--name", name,
			"--project", scope.project,
			"--session", sessionId,
			"--ttl", String(timeoutMs),
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("waiter did not become ready")), 5000);
		child.stdout!.on("data", (d) => {
			if (d.toString().includes("READY")) {
				clearTimeout(t);
				resolve();
			}
		});
		child.on("exit", () => reject(new Error("waiter exited early")));
	});
	child.unref();
	child.stdout!.destroy();

	const id: SenderIdentity = { session_id: sessionId, name, endpoint, cwd: process.cwd() };
	const env = makePromptEnvelope(id, prompt);
	fs.writeFileSync(
		path.join(spool.pending, `${env.msg_id}.json`),
		JSON.stringify({ msg_id: env.msg_id, target: peer.name, sent_at: nowIso() }),
	);
	try {
		await sendEnvelope(peer.endpoint, env);
	} catch (err) {
		try { fs.unlinkSync(path.join(spool.pending, `${env.msg_id}.json`)); } catch { /* ignore */ }
		try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
		die(`send failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	console.log(env.msg_id);
}

// ━━ _listen (internal detached waiter) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdListen(argv: string[]): Promise<void> {
	const name = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const project = flagValue(argv, "--project") ?? "default";
	const sessionId = flagValue(argv, "--session") ?? ulid();
	const ttl = Number(flagValue(argv, "--ttl") ?? DEFAULT_AWAIT_MS);
	const id = makeIdentity(name, sessionId);
	const spool = ensureSpool(name);
	ensureComsDirs(project);

	const server = await bindEndpoint(
		id.endpoint,
		makeConnHandler((env, socket) => {
			if (isResponseEnvelope(env)) {
				writeAck(socket, env.msg_id);
				fs.writeFileSync(
					path.join(spool.responses, `${env.msg_id}.json`),
					JSON.stringify({ response: env.response, error: env.error ?? null, received_at: nowIso() }),
				);
				try { fs.unlinkSync(path.join(spool.pending, `${env.msg_id}.json`)); } catch { /* ignore */ }
				maybeExit();
			} else if (isPromptEnvelope(env)) {
				// Bidirectionality bonus: inbound prompts spool for a human /
				// hook to answer via `coms-cli reply <msg_id> …`.
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
				writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "unsupported envelope");
			}
		}),
	);
	registerCliEntry(id, project, "coms-cli reply waiter");
	console.log("READY");

	const cleanup = () => {
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
		removeRegistryEntry(project, id.name);
		process.exit(0);
	};
	// Exit when no pending markers remain (grace period lets the sender write
	// the first marker after READY).
	const startedAt = Date.now();
	function maybeExit(): void {
		try {
			const pendingLeft = fs.readdirSync(spool.pending).length;
			if (pendingLeft === 0 && Date.now() - startedAt > 3000) cleanup();
		} catch {
			// ignore
		}
	}
	setInterval(maybeExit, 5000);
	setTimeout(cleanup, ttl); // TTL fallback
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
}

// ━━ await ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdAwait(argv: string[]): Promise<void> {
	const msgId = argv.find((a) => !a.startsWith("--"));
	if (!msgId) die("usage: coms-cli await <msg_id> [--timeout <ms>]");
	const name = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const timeoutMs = Number(flagValue(argv, "--timeout") ?? DEFAULT_AWAIT_MS);
	const spool = ensureSpool(name);
	const file = path.join(spool.responses, `${msgId}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (rec.error) die(`peer error: ${rec.error}`);
			console.log(typeof rec.response === "string" ? rec.response : JSON.stringify(rec.response, null, 2));
			return;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	die(`timeout: no reply for ${msgId} after ${timeoutMs}ms`);
}

// ━━ reply ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function cmdReply(argv: string[]): Promise<void> {
	const positional = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
	const [msgId, ...textParts] = positional;
	let text = textParts.join(" ");
	if (!text && !process.stdin.isTTY) {
		text = fs.readFileSync(0, "utf-8").trim();
	}
	if (!msgId || !text) die("usage: coms-cli reply <msg_id> <text…>   (or pipe the text on stdin)");
	const name = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const spool = ensureSpool(name);
	const recFile = path.join(spool.inbound, `${msgId}.json`);
	if (!fs.existsSync(recFile)) die(`No inbound prompt ${msgId} in ${spool.inbound}`);
	const rec = JSON.parse(fs.readFileSync(recFile, "utf-8"));
	const id = makeIdentity(name, ulid());
	await sendEnvelope(rec.sender_endpoint, makeResponseEnvelope(id, msgId, text));
	fs.unlinkSync(recFile);
	console.log(`replied to ${rec.sender_name ?? rec.sender_session} (${msgId})`);
}

// ━━ main ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case "list":
			return cmdList(rest);
		case "send":
			return cmdSend(rest);
		case "await":
			return cmdAwait(rest);
		case "reply":
			return cmdReply(rest);
		case "_listen":
			return cmdListen(rest);
		default:
			console.error("usage: coms-cli <list|send|await|reply> …");
			process.exit(2);
	}
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
