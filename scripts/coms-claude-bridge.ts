// scripts/coms-claude-bridge.ts
//
// The Claude Code ↔ coms bridge: one bridge per Claude Code pane, launched
// next to it (the `_claude-peer` recipe backgrounds the bridge in the same
// herdr pane). It makes an interactive Claude Code a first-class coms peer:
//
//   (a) binds a coms endpoint + registry entry under --name, so the Claude
//       pane appears in every pool widget and is addressable via coms_send;
//   (b) inbound prompt envelope → pane.send_text into the Claude pane
//       (+ Enter as a separate send — spike quirk);
//   (c) completion, primary path: the Claude Code Stop hook
//       (hooks/coms-stop-hook.mjs) writes the turn's last message to
//       ~/.pi/coms/claude-bridge/<pane>/last-message.json; fallback when no
//       hook has ever fired for this pane: a <<COMS_DONE:msg_id>> sentinel is
//       requested in the prompt and scraped via pane.read after herdr reports
//       the agent done;
//   (d) sends the response envelope back to the sender;
//   (e) a `blocked` agent status returns a readable error envelope instead of
//       hanging until timeout;
//   (f) prompts are strictly serialized per pane; queue depth is reported in
//       the agent card + herdr custom_status.
//
// usage: coms-claude-bridge.ts --name <peer-name> [--pane <pane_id>]
//        [--project <p>] [--reply-timeout <ms>]
//   --pane defaults to HERDR_PANE_ID (set inside every herdr pane).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	bindEndpoint,
	ensureComsDirs,
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
	extractSentinelReply,
	formatPanePrompt,
	parseHookRecord,
	PromptQueue,
} from "./lib/claude-bridge-core.ts";
import { herdr, requireHerdr, HerdrUnavailableError } from "../.pi/harnesses/lib/herdr-client.ts";

const KEEPALIVE_MS = 30_000;
const ENTER_DELAY_MS = 1_500;
const POLL_MS = 1_000;
const DEFAULT_REPLY_TIMEOUT_MS = 600_000;
const COLOR = "#FF8B39";

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function die(msg: string): never {
	console.error(`coms-claude-bridge: ${msg}`);
	process.exit(1);
}

export function hookWatchDir(paneId: string): string {
	return path.join(os.homedir(), ".pi", "coms", "claude-bridge", paneId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const name = flagValue(argv, "--name") ?? die("--name <peer-name> is required");
	const project = flagValue(argv, "--project") ?? "default";
	const paneId = flagValue(argv, "--pane") ?? process.env.HERDR_PANE_ID ?? die("--pane <pane_id> required (or run inside a herdr pane)");
	const replyTimeoutMs = Number(flagValue(argv, "--reply-timeout") ?? DEFAULT_REPLY_TIMEOUT_MS);

	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) die(err.message);
		throw err;
	}

	// ── identity ──
	ensureComsDirs(project);
	const sessionId = ulid();
	const uniqueName = resolveUniqueName(project, name);
	const id: SenderIdentity = {
		session_id: sessionId,
		name: uniqueName,
		endpoint: makeEndpoint(sessionId),
		cwd: process.cwd(),
	};
	const queue = new PromptQueue<PromptEnvelope>();
	const purpose = "Claude Code (bridged pane)";

	function registryEntry(): RegistryEntry {
		return {
			session_id: sessionId,
			name: uniqueName,
			purpose,
			model: "claude-code",
			color: COLOR,
			pid: process.pid,
			endpoint: id.endpoint,
			cwd: id.cwd,
			started_at: nowIso(),
			explicit: false,
			version: 1,
			context_used_pct: 0,
			queue_depth: queue.depth,
			heartbeat_at: nowIso(),
		};
	}

	const hookDir = hookWatchDir(paneId);
	fs.mkdirSync(hookDir, { recursive: true });
	const hookFile = path.join(hookDir, "last-message.json");
	// Hook mode flips on permanently the first time the Stop hook writes for
	// this pane; until then prompts carry the sentinel instruction.
	let hookSeen = fs.existsSync(hookFile);

	// ── envelope server ──
	const server = await bindEndpoint(
		id.endpoint,
		makeConnHandler((env, socket) => {
			if (isPromptEnvelope(env)) {
				if (env.hops >= 5) {
					writeNack(socket, env.msg_id, "hops exceeded");
					return;
				}
				queue.push(env);
				writeAck(socket, env.msg_id);
				void pump();
			} else if ((env as { type?: string }).type === "ping") {
				const card: AgentCard = {
					name: uniqueName,
					purpose,
					model: "claude-code",
					color: COLOR,
					context_used_pct: 0,
					queue_depth: queue.depth,
				};
				try {
					socket.write(JSON.stringify({ type: "pong", msg_id: (env as { msg_id?: string }).msg_id ?? "", agent_card: card }) + "\n");
				} catch { /* ignore */ }
				try { socket.end(); } catch { /* ignore */ }
			} else {
				writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "bridge accepts prompts and pings");
			}
		}),
	);
	writeRegistryAtomic(registryEntry(), project);
	console.error(`coms-claude-bridge: ${uniqueName}@${project} bridging pane ${paneId}`);

	// ── presence ──
	async function reportPresence(): Promise<void> {
		try {
			await herdr.paneReportMetadata({
				pane_id: paneId,
				source: `coms-bridge:${sessionId}`,
				agent: "claude",
				custom_status: `${uniqueName} q${queue.depth}`.slice(0, 32),
				ttl_ms: 90_000,
			});
		} catch { /* best-effort */ }
	}
	const keepalive = setInterval(() => {
		try {
			writeRegistryAtomic(registryEntry(), project);
		} catch { /* best-effort */ }
		void reportPresence();
	}, KEEPALIVE_MS);
	keepalive.unref?.();
	void reportPresence();

	// ── prompt processing (strictly serial) ──
	async function pump(): Promise<void> {
		const item = queue.take();
		if (!item) return;
		const env = item.envelope;
		try {
			const reply = await driveClaude(env);
			await sendEnvelope(env.sender_endpoint, makeResponseEnvelope(id, env.msg_id, reply));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			try {
				await sendEnvelope(env.sender_endpoint, makeResponseEnvelope(id, env.msg_id, null, message));
			} catch {
				console.error(`coms-claude-bridge: could not deliver error for ${env.msg_id}: ${message}`);
			}
		} finally {
			queue.done();
			void reportPresence();
			void pump(); // next in line
		}
	}

	async function paneStatus(): Promise<string> {
		try {
			const { pane } = await herdr.paneGet(paneId);
			return (pane.agent_status as string) ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	async function driveClaude(env: PromptEnvelope): Promise<string> {
		const sentinelMode = !hookSeen;
		const hookMtimeBefore = fs.existsSync(hookFile) ? fs.statSync(hookFile).mtimeMs : 0;

		// Claude Code must be idle-ish before we type into its input box.
		const before = await paneStatus();
		if (before === "working") {
			throw new Error(`Claude Code in pane ${paneId} is mid-turn (working) — try again shortly`);
		}

		await herdr.paneSendText(paneId, formatPanePrompt(env, sentinelMode));
		await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
		await herdr.paneSendKeys(paneId, ["enter"]);

		const deadline = Date.now() + replyTimeoutMs;
		let sawWorking = false;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_MS));

			// primary: Stop hook wrote a new record
			if (fs.existsSync(hookFile)) {
				const mtime = fs.statSync(hookFile).mtimeMs;
				if (mtime > hookMtimeBefore) {
					const rec = parseHookRecord(fs.readFileSync(hookFile, "utf-8"));
					if (rec) {
						hookSeen = true;
						return rec.text;
					}
				}
			}

			const status = await paneStatus();
			if (status === "working") sawWorking = true;
			if (status === "blocked") {
				throw new Error(
					`Claude Code in pane ${paneId} is blocked on a permission prompt — a human must approve it in the pane`,
				);
			}
			// fallback: turn ended without a hook record → scrape the sentinel
			if (sentinelMode && sawWorking && (status === "done" || status === "idle")) {
				const read = await herdr.paneRead({ pane_id: paneId, source: "recent", lines: 200 });
				const reply = extractSentinelReply(read.read.text, env.msg_id);
				if (reply) return reply;
				// sentinel not visible yet — keep polling until deadline
			}
		}
		throw new Error(
			`no reply from Claude Code within ${replyTimeoutMs}ms` +
				(sentinelMode ? " (Stop hook not installed? see hooks/coms-stop-hook.mjs)" : ""),
		);
	}

	// ── shutdown ──
	let shuttingDown = false;
	function shutdown(): void {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepalive);
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
		removeRegistryEntry(project, uniqueName);
		process.exit(0);
	}
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
