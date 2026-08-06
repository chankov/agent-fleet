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
//       the agent card + the pane's herdr peer annotation.
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
	paneAgentStatusToPeerStatus,
	removeRegistryEntry,
	resolveUniqueName,
	sendEnvelope,
	ulid,
	writeAck,
	writeNack,
	writeRegistryAtomic,
	type AgentCard,
	type PeerStatus,
	type PromptEnvelope,
	type RegistryEntry,
	type SenderIdentity,
} from "./lib/coms-envelope.ts";
import {
	extractSentinelReply,
	formatPanePrompt,
	idleWaitBudgetMs,
	idleWaitDelayMs,
	isReplyPendingError,
	parseHookRecord,
	PromptQueue,
	REPLY_TIMEOUT_HARD_CAP_MS,
	ReplyPendingError,
	replyDeadlineAt,
	resolveReplyTimeoutMs,
	waitForClaudePaneReady,
} from "./lib/claude-bridge-core.ts";
import { herdr, requireHerdr, HerdrUnavailableError } from "../.pi/harnesses/lib/herdr-client.ts";
import { HerdrPresence } from "../.pi/harnesses/lib/herdr-presence.ts";
import { buildLiveRegistryEntry, type ComsIdentity } from "../.pi/harnesses/lib/coms-registry-entry.ts";

const KEEPALIVE_MS = 30_000;
const ENTER_DELAY_MS = 1_500;
const POLL_MS = 1_000;
// 30 minutes, matching coms_await's own default (PI_COMS_TIMEOUT_MS). The old
// 10-minute default silently truncated every longer request: a caller asking for
// 1_800_000ms was still failed at 600_000ms.
const DEFAULT_REPLY_TIMEOUT_MS = 1_800_000;
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

// ── registry record ──
//
// Split in two on purpose. The identity is built ONCE, at registration, and
// holds `started_at`; the entry is rebuilt on every 30s keepalive from that
// same identity. The bridge used to rebuild the whole record inline with
// `started_at: nowIso()`, so the field never held the start of anything and
// every bridged Claude peer reported an uptime of at most one tick — the bug
// the pi harnesses fixed by centralising on buildLiveRegistryEntry. Reusing it
// here rather than keeping a third copy is the point.

export function bridgeRegistryIdentity(reg: {
	sessionId: string;
	name: string;
	purpose: string;
	endpoint: string;
	cwd: string;
	startedAt: string;
}): ComsIdentity {
	return {
		session_id: reg.sessionId,
		name: reg.name,
		purpose: reg.purpose,
		// A bridged pane is Claude Code by construction — there is no live ctx to
		// re-read a model from, so the registered one is the only one.
		model: "claude-code",
		color: COLOR,
		endpoint: reg.endpoint,
		cwd: reg.cwd,
		explicit: false,
		started_at: reg.startedAt,
	};
}

export function bridgeRegistryEntry(
	identity: ComsIdentity,
	live: { now: string; pid: number; queueDepth: number },
): RegistryEntry {
	return buildLiveRegistryEntry(identity, {
		now: live.now,
		pid: live.pid,
		// context_used_pct is not observable from outside a Claude pane; 0 is what
		// the agent card and the herdr annotation carry too, so they all agree.
		contextUsedPct: 0,
		queueDepth: live.queueDepth,
	});
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

	// `_claude-peer` backgrounds this bridge before the shell starts Claude Code.
	// Do not publish a coms identity during that gap: Hub peer readiness is based
	// on registration, and an immediate prompt typed into the still-booting pane
	// is lost while the Claude TUI replaces the shell screen.
	const startup = await waitForClaudePaneReady(async () => (await herdr.paneGet(paneId)).pane);
	if (!startup.ready) {
		die(`Claude Code was not detected as ready in pane ${paneId} after ${Math.round(startup.waitedMs / 1000)}s`);
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

	// Built once — `started_at` is registration time and stays put across every
	// keepalive rebuild below.
	const registryIdentity = bridgeRegistryIdentity({
		sessionId,
		name: uniqueName,
		purpose,
		endpoint: id.endpoint,
		cwd: id.cwd,
		startedAt: nowIso(),
	});

	function registryEntry(): RegistryEntry {
		return bridgeRegistryEntry(registryIdentity, {
			now: nowIso(),
			pid: process.pid,
			queueDepth: queue.depth,
		});
	}

	const hookDir = hookWatchDir(paneId);
	fs.mkdirSync(hookDir, { recursive: true });
	const hookFile = path.join(hookDir, "last-message.json");
	// Hook mode flips on permanently the first time the Stop hook writes for
	// this pane; until then prompts carry the sentinel instruction.
	let hookSeen = fs.existsSync(hookFile);

	// Latest known pane state. The ping handler is synchronous — a pool refresh
	// must not block on a herdr round trip per peer — so it answers from this
	// cache, which `paneStatus()` refreshes on the keepalive and on every poll
	// during a turn. Starts at "booting": registered, nothing observed yet.
	let lastPaneState: PeerStatus = "booting";
	/** What this bridge reports to a sender: a queued prompt already means busy. */
	const peerStatus = (): PeerStatus => (queue.depth > 0 ? "working" : lastPaneState);

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
					pane_id: paneId,
					status: peerStatus(),
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
	// Annotation ONLY, never pane.report_agent: this pane's `agent_status` is
	// herdr's own Claude detection, and driveClaude() polls it back to decide a
	// turn is over. A state we reported ourselves would be us answering our own
	// question. Dialect negotiation (tokens on herdr >= 0.7.4, one latched
	// fallback to custom_status) is HerdrPresence's job — a second copy here is
	// how the bridge stayed on the removed field while the pi path was fixed.
	const presence = new HerdrPresence({
		paneId,
		source: `coms-bridge:${sessionId}`,
		agentLabel: "claude",
		onError: (err, dialect) =>
			console.error(`coms-claude-bridge: herdr rejected the ${dialect} annotation: ${err.message}`),
	});
	async function reportPresence(): Promise<void> {
		// context_used_pct is not observable from outside a Claude pane; 0 is
		// what the agent card carries too, so the sidebar and the card agree.
		await presence.annotate({ name: uniqueName, project, contextUsedPct: 0, queueDepth: queue.depth });
	}
	const keepalive = setInterval(() => {
		try {
			writeRegistryAtomic(registryEntry(), project);
		} catch { /* best-effort */ }
		void reportPresence();
		// Keep the ping cache warm between turns, so an idle pane is reported as
		// idle rather than staying "booting" until someone sends to it.
		void paneStatus();
	}, KEEPALIVE_MS);
	keepalive.unref?.();
	void reportPresence();
	void paneStatus();

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
			if (isReplyPendingError(err)) {
				// No response envelope: the sender's wait expires as `pending`, and may
				// await/get again without treating unfinished work as a failed result.
				console.error(`coms-claude-bridge: ${env.msg_id} remains pending: ${message}`);
			} else {
				try {
					await sendEnvelope(env.sender_endpoint, makeResponseEnvelope(id, env.msg_id, null, message));
				} catch {
					console.error(`coms-claude-bridge: could not deliver error for ${env.msg_id}: ${message}`);
				}
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
			const status = (pane.agent_status as string) ?? "unknown";
			lastPaneState = paneAgentStatusToPeerStatus(status);
			return status;
		} catch {
			return "unknown";
		}
	}

	async function driveClaude(env: PromptEnvelope): Promise<string> {
		const sentinelMode = !hookSeen;
		const hookMtimeBefore = fs.existsSync(hookFile) ? fs.statSync(hookFile).mtimeMs : 0;
		// The caller's declared deadline wins over the bridge default (clamped).
		// One absolute deadline covers BOTH idle waiting and the reply; otherwise a
		// two-minute busy wait silently extends the caller's budget.
		const effectiveTimeoutMs = resolveReplyTimeoutMs(env.reply_timeout_ms, replyTimeoutMs);
		const startedAt = Date.now();
		const replyDeadline = replyDeadlineAt(startedAt, effectiveTimeoutMs);

		// Claude Code must be idle-ish before we type into its input box — but a busy
		// pane is a wait, not a failure. Throwing here made every mid-turn moment a
		// hard error and pushed callers into hot-retry loops.
		const waitDeadline = Math.min(replyDeadline, startedAt + idleWaitBudgetMs(effectiveTimeoutMs));
		const waitStarted = startedAt;
		for (let attempt = 0; ; attempt++) {
			if (await paneStatus() !== "working") break;
			const remaining = waitDeadline - Date.now();
			if (remaining <= 0) {
				throw new Error(
					`Claude Code in pane ${paneId} is still mid-turn after waiting ` +
					`${Math.round((Date.now() - waitStarted) / 1000)}s — try again shortly`,
				);
			}
			await new Promise((r) => setTimeout(r, Math.min(idleWaitDelayMs(attempt), remaining)));
		}

		await herdr.paneSendText(paneId, formatPanePrompt(env, sentinelMode));
		await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
		await herdr.paneSendKeys(paneId, ["enter"]);

		// The sender's local await returns `pending` at replyDeadline, but the
		// bridge keeps watching the already-running turn up to the hard cap so a
		// late completion can still resolve the original msg_id.
		const monitorDeadline = replyDeadlineAt(startedAt, REPLY_TIMEOUT_HARD_CAP_MS);
		let pendingLogged = false;
		let sawWorking = false;
		while (Date.now() < monitorDeadline) {
			await new Promise((r) => setTimeout(r, POLL_MS));
			if (!pendingLogged && Date.now() >= replyDeadline) {
				pendingLogged = true;
				console.error(`coms-claude-bridge: ${env.msg_id} exceeded its reply budget and remains pending`);
			}

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
		throw new ReplyPendingError(
			`no reply from Claude Code before the ${REPLY_TIMEOUT_HARD_CAP_MS}ms hard monitoring cap (requested ${effectiveTimeoutMs}ms)` +
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
