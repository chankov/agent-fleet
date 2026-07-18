// scripts/coms-hermes-bridge.ts
//
// Hermes/Telegram user-remote bridge daemon. Registers a coms peer, turns
// prompt envelopes into `hermes send` messages, watches the private answer-file
// wire, and replies to the sender with the mapped answer/error envelope.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	bindEndpoint,
	ensureComsDirs,
	isCancelEnvelope,
	isPromptEnvelope,
	makeConnHandler,
	makeEndpoint,
	makeResponseEnvelope,
	nowIso,
	removeRegistryEntry,
	resolveUniqueName,
	sendEnvelope,
	ulid,
	writeAck,
	writeNack,
	writeRegistryAtomic,
	type AgentCard,
	type PromptEnvelope,
	type RegistryEntry,
	type SenderIdentity,
} from "./lib/coms-envelope.ts";
import {
	formatTelegramQuestion,
	isValidQid,
	logPath as defaultLogPath,
	makeLogRecord,
	mapAnswerToAskResponse,
	qidFromPromptEnvelope,
	questionsDir as defaultQuestionsDir,
	renderLogRecord,
	timeoutMsFromEnv,
	timeoutOutcome,
	validateAnswerFile,
	type BridgeEventName,
	type QuestionOption,
	type QuestionState,
} from "./lib/hermes-bridge-core.ts";

const KEEPALIVE_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const COLOR = "#38BDF8";
const DEFAULT_NAME = "user-remote";
const DEFAULT_PURPOSE = "Remote human via Hermes/Telegram";

interface PendingQuestion {
	env: PromptEnvelope;
	state: QuestionState;
	options: QuestionOption[];
	timer: NodeJS.Timeout;
}

interface ParsedPrompt {
	question: string;
	context?: string;
	options: QuestionOption[];
}

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function die(msg: string): never {
	console.error(`coms-hermes-bridge: ${msg}`);
	process.exit(1);
}

function parsePrompt(env: PromptEnvelope): ParsedPrompt {
	try {
		const parsed = JSON.parse(env.prompt) as { question?: unknown; context?: unknown; options?: unknown };
		if (parsed && typeof parsed === "object" && typeof parsed.question === "string") {
			const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
			const options = rawOptions
				.map((option): QuestionOption | null => {
					if (typeof option === "string") return { title: option };
					if (option && typeof option === "object" && typeof (option as { title?: unknown }).title === "string") {
						const desc = (option as { description?: unknown }).description;
						return typeof desc === "string"
							? { title: (option as { title: string }).title, description: desc }
							: { title: (option as { title: string }).title };
					}
					return null;
				})
				.filter((option): option is QuestionOption => option !== null);
			const context = typeof parsed.context === "string" && parsed.context.trim() ? parsed.context : undefined;
			return { question: parsed.question, context, options };
		}
	} catch {
		// Plain coms-cli prompts are expected; fall through.
	}
	return {
		question: env.prompt,
		context: `From ${env.sender_name} @ ${env.sender_cwd}`,
		options: [],
	};
}

function appendLogFile(logFile: string, qid: string, event: BridgeEventName, detail?: unknown): void {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.appendFileSync(logFile, renderLogRecord(makeLogRecord(qid, event, detail)));
}

function appendAnswerRejectLog(logFile: string, qid: string, detail: unknown): void {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.appendFileSync(logFile, JSON.stringify({ at: nowIso(), qid, event: "answer_rejected", detail }) + "\n");
}

function hermesSend(to: string, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("hermes", ["send", "--to", to, text], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let stdout = "";
		child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
		child.once("error", (err) => reject(err));
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			const detail = (stderr || stdout).trim();
			reject(new Error(`hermes send failed${code === null ? "" : ` (${code})`}${detail ? `: ${detail}` : ""}`));
		});
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const requestedName = flagValue(argv, "--name") ?? DEFAULT_NAME;
	const project = flagValue(argv, "--project") ?? "default";
	const to = flagValue(argv, "--to") ?? "telegram";
	const timeoutMs = Number(flagValue(argv, "--timeout") ?? timeoutMsFromEnv());
	const pollMs = Number(flagValue(argv, "--poll-ms") ?? DEFAULT_POLL_MS);
	const qDir = flagValue(argv, "--questions-dir") ?? defaultQuestionsDir();
	const logFile = path.join(path.dirname(qDir), path.basename(defaultLogPath()));

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die("--timeout must be a positive number");
	if (!Number.isFinite(pollMs) || pollMs <= 0) die("--poll-ms must be a positive number");

	ensureComsDirs(project);
	fs.mkdirSync(qDir, { recursive: true });
	fs.mkdirSync(path.dirname(logFile), { recursive: true });

	const sessionId = ulid();
	const uniqueName = resolveUniqueName(project, requestedName);
	const id: SenderIdentity = {
		session_id: sessionId,
		name: uniqueName,
		endpoint: makeEndpoint(sessionId),
		cwd: process.cwd(),
	};
	const pending = new Map<string, PendingQuestion>();
	const closed = new Map<string, QuestionState>();
	// Answer files the liaison may still be mid-write: an invalid_json file is
	// kept for a short grace window (first-seen timestamps below) instead of
	// being eaten while the write is still in flight.
	const invalidJsonSeen = new Map<string, number>();
	const invalidJsonGraceMs = Math.max(2 * pollMs, 1_000);
	const CLOSED_CAP = 1_000;

	function markClosed(qid: string, state: QuestionState): void {
		closed.set(qid, state);
		if (closed.size > CLOSED_CAP) {
			const oldest = closed.keys().next().value;
			if (oldest !== undefined) closed.delete(oldest);
		}
	}

	function queueDepth(): number {
		return pending.size;
	}

	function registryEntry(): RegistryEntry {
		return {
			session_id: sessionId,
			name: uniqueName,
			purpose: DEFAULT_PURPOSE,
			model: "hermes-bridge",
			color: COLOR,
			pid: process.pid,
			endpoint: id.endpoint,
			cwd: id.cwd,
			started_at: nowIso(),
			explicit: false,
			version: 1,
			context_used_pct: 0,
			queue_depth: queueDepth(),
			heartbeat_at: nowIso(),
		};
	}

	async function sendResponse(env: PromptEnvelope, response: unknown, error: string | null = null): Promise<void> {
		await sendEnvelope(env.sender_endpoint, makeResponseEnvelope(id, env.msg_id, response, error));
	}

	async function handleTimeout(qid: string): Promise<void> {
		const item = pending.get(qid);
		if (!item) return;
		pending.delete(qid);
		markClosed(qid, "timeout");
		appendLogFile(logFile, qid, "timeout", { timeout_ms: timeoutMs });
		const outcome = timeoutOutcome(qid, timeoutMs);
		await hermesSend(to, outcome.telegramNote).catch((err) => {
			appendLogFile(logFile, qid, "delivery_error", { phase: "timeout_note", error: err instanceof Error ? err.message : String(err) });
		});
		await sendResponse(item.env, outcome.response, outcome.error).catch((err) => {
			console.error(`coms-hermes-bridge: could not deliver timeout for ${qid}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	async function handlePrompt(env: PromptEnvelope): Promise<void> {
		let qid: string;
		try {
			qid = qidFromPromptEnvelope(env);
		} catch (err) {
			await sendResponse(env, null, err instanceof Error ? err.message : String(err)).catch(() => {});
			return;
		}

		const parsed = parsePrompt(env);
		const duplicate = pending.get(qid);
		if (duplicate) clearTimeout(duplicate.timer);
		appendLogFile(logFile, qid, "question_received", { from: env.sender_name });
		const timer = setTimeout(() => { void handleTimeout(qid); }, timeoutMs);
		timer.unref?.();
		pending.set(qid, { env, state: "pending", options: parsed.options, timer });

		try {
			await hermesSend(to, formatTelegramQuestion({
				qid,
				question: parsed.question,
				context: parsed.context,
				options: parsed.options,
			}));
			const item = pending.get(qid);
			if (!item) return;
			item.state = "delivered";
			appendLogFile(logFile, qid, "delivered", { to });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const item = pending.get(qid);
			if (item) {
				clearTimeout(item.timer);
				pending.delete(qid);
			}
			appendLogFile(logFile, qid, "delivery_error", { error: message });
			await sendResponse(env, null, message).catch((sendErr) => {
				console.error(`coms-hermes-bridge: could not deliver error for ${qid}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
			});
		}
	}

	async function handleCancel(refMsgId: string): Promise<void> {
		if (!isValidQid(refMsgId)) return;
		const item = pending.get(refMsgId);
		if (!item) return;
		clearTimeout(item.timer);
		pending.delete(refMsgId);
		markClosed(refMsgId, "cancelled");
		appendLogFile(logFile, refMsgId, "cancelled", { reason: "cancel envelope" });
		await hermesSend(to, `✖ [HUB-Q:${refMsgId}] Въпросът е отменен — отговорено е от конзолата.`).catch((err) => {
			appendLogFile(logFile, refMsgId, "delivery_error", { phase: "cancel_note", error: err instanceof Error ? err.message : String(err) });
		});
	}

	async function handleLateAnswer(qid: string): Promise<void> {
		appendLogFile(logFile, qid, "late_answer", { state: closed.get(qid) ?? "unknown" });
		await hermesSend(to, `ℹ [HUB-Q:${qid}] Този въпрос вече е затворен; късният отговор е игнориран.`).catch((err) => {
			appendLogFile(logFile, qid, "delivery_error", { phase: "late_note", error: err instanceof Error ? err.message : String(err) });
		});
	}

	async function consumeAnswerFile(file: string): Promise<void> {
		const full = path.join(qDir, file);
		let raw: string;
		try {
			raw = fs.readFileSync(full, "utf-8");
		} catch {
			return;
		}

		const qidFromName = file.endsWith(".answer.json") ? file.slice(0, -".answer.json".length) : file;
		if (isValidQid(qidFromName) && closed.has(qidFromName)) {
			invalidJsonSeen.delete(file);
			try { fs.unlinkSync(full); } catch { /* ignore */ }
			await handleLateAnswer(qidFromName);
			return;
		}

		const validation = validateAnswerFile(raw, full, pending.keys());
		if (!validation.ok) {
			if (validation.reason === "invalid_json") {
				// Possibly a partial write from the liaison; retry until the grace expires.
				const firstSeen = invalidJsonSeen.get(file);
				if (firstSeen === undefined) {
					invalidJsonSeen.set(file, Date.now());
					return;
				}
				if (Date.now() - firstSeen < invalidJsonGraceMs) return;
			}
			invalidJsonSeen.delete(file);
			const logQid = validation.qid && isValidQid(validation.qid) ? validation.qid : (isValidQid(qidFromName) ? qidFromName : "00000000000000000000000000");
			appendAnswerRejectLog(logFile, logQid, { reason: validation.reason, file });
			try { fs.unlinkSync(full); } catch { /* ignore */ }
			return;
		}

		invalidJsonSeen.delete(file);
		const item = pending.get(validation.qid);
		if (!item) return;
		clearTimeout(item.timer);
		pending.delete(validation.qid);
		markClosed(validation.qid, "answered");
		try { fs.unlinkSync(full); } catch { /* ignore */ }
		appendLogFile(logFile, validation.qid, "answered", { answered_by: validation.answer.answered_by });
		const response = mapAnswerToAskResponse(validation.answer.answer, item.options);
		await sendResponse(item.env, response).catch((err) => {
			console.error(`coms-hermes-bridge: could not deliver answer for ${validation.qid}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	async function scanAnswers(): Promise<void> {
		let files: string[];
		try {
			files = fs.readdirSync(qDir);
		} catch {
			return;
		}
		for (const file of files) {
			await consumeAnswerFile(file);
		}
	}

	const server = await bindEndpoint(
		id.endpoint,
		makeConnHandler((env, socket) => {
			if (isPromptEnvelope(env)) {
				writeAck(socket, env.msg_id);
				void handlePrompt(env);
			} else if (isCancelEnvelope(env)) {
				writeAck(socket, env.msg_id);
				void handleCancel(env.ref_msg_id);
			} else if ((env as { type?: string }).type === "ping") {
				const card: AgentCard = {
					name: uniqueName,
					purpose: DEFAULT_PURPOSE,
					model: "hermes-bridge",
					color: COLOR,
					context_used_pct: 0,
					queue_depth: queueDepth(),
				};
				try {
					socket.write(JSON.stringify({ type: "pong", msg_id: (env as { msg_id?: string }).msg_id ?? "", agent_card: card }) + "\n");
				} catch { /* ignore */ }
				try { socket.end(); } catch { /* ignore */ }
			} else {
				writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "bridge accepts prompts, cancels, and pings");
			}
		}),
	);

	const keepalive = setInterval(() => {
		try { writeRegistryAtomic(registryEntry(), project); } catch { /* best-effort */ }
	}, KEEPALIVE_MS);
	keepalive.unref?.();
	const watcher = setInterval(() => { void scanAnswers(); }, pollMs);
	watcher.unref?.();

	let shuttingDown = false;
	function shutdown(): void {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepalive);
		clearInterval(watcher);
		for (const item of pending.values()) clearTimeout(item.timer);
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
		removeRegistryEntry(project, uniqueName);
		process.exit(0);
	}
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Publish readiness only after shutdown handlers are installed. A caller may
	// terminate the bridge as soon as its registry entry appears; publishing
	// earlier can bypass cleanup and leave both the entry and socket behind.
	writeRegistryAtomic(registryEntry(), project);
	console.error(`coms-hermes-bridge: ${uniqueName}@${project} listening (${to})`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
