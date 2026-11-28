import { parseReview } from "../../harnesses/lib/coms-review.ts";
import {sessionRootsFromEnv,projectForSession,executionRoot,targetEnvironment} from "../../harnesses/lib/workspace-context.ts";
// .pi/agent-fleet/scripts/coms-claude-bridge.ts
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
//       (.pi/agent-fleet/hooks/coms-stop-hook.mjs) writes the turn's last message to
//       ~/.pi/coms/claude-bridge/<pane>/last-message.json; fallback when no
//       hook has ever fired for this pane: a <<COMS_DONE:msg_id>> sentinel is
//       requested in the prompt and scraped via pane.read after herdr reports
//       the agent done;
//   (d) sends the response envelope back to the sender;
//   (e) permission prompts after submission keep the original dispatch pending;
//   (f) prompts are strictly serialized per pane; queue depth is reported in
//       the agent card + the pane's herdr peer annotation.
//
// usage: coms-claude-bridge.ts --name <peer-name> [--pane <pane_id>]
//        [--project <p>] [--reply-timeout <ms>]
//        [--read-only [--model <m>] [--resume <session>]]
//   --pane defaults to HERDR_PANE_ID (set inside every herdr pane).
//   --read-only: the bridge itself launches Claude Code in THIS pane, in the
//       foreground, with the enforced read-only argv (claudeReadOnlyArgv), and
//       only then declares `read_only: true` in its registry entry. It exits —
//       and deregisters — when that Claude process exits, so a later Claude
//       started by hand in the pane can never inherit the declaration. Without
//       --read-only nothing changes: Claude is started next to the bridge by
//       the `_claude-peer` recipe and the entry carries no `read_only`.

import { spawn, type ChildProcess } from "node:child_process";
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
	extractSentinelReply, extractPaneReview,
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
import { herdr, requireHerdr, HerdrUnavailableError } from "../../../.pi/harnesses/lib/herdr-client.ts";
import { HerdrPresence } from "../../../.pi/harnesses/lib/herdr-presence.ts";
import { buildLiveRegistryEntry, type ComsIdentity } from "../../../.pi/harnesses/lib/coms-registry-entry.ts";

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

// ── read-only launch (PLAN-11-01, maintainer decision D3) ──
//
// Verified against Claude Code 2.1.330 (`claude --help`, and the session's own
// `system/init` record under `-p --output-format stream-json`, which lists the
// effective tools and MCP servers):
//   --tools Read,Grep,Glob  → built-in tools limited to exactly Glob/Grep/Read;
//   --strict-mcp-config     → with no --mcp-config: zero MCP servers. Required:
//                             `--tools` alone keeps every MCP tool (plugin and
//                             claude.ai connectors — mail, file upload, …);
//   --disallowedTools …     → deny rules for the mutating/egress built-ins, in
//                             case a future build re-adds one past `--tools`;
//   --permission-mode dontAsk → anything that would prompt is denied, so an
//                             unattended peer never waits on (or gets) approval.

/** The only built-in tools a read-only Claude Code peer keeps. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
/** Mutating or egress built-ins additionally denied (defense in depth). */
export const CLAUDE_READ_ONLY_DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] as const;

const CLAUDE_READ_ONLY_PREFIX: readonly string[] = [
	"--tools", CLAUDE_READ_ONLY_TOOLS.join(","),
	"--disallowedTools", CLAUDE_READ_ONLY_DENIED_TOOLS.join(","),
	"--strict-mcp-config",
	"--permission-mode", "dontAsk",
];

function launchValue(flag: string, value: string): string {
	if (value === "" || value.startsWith("-") || /[\r\n]/.test(value)) {
		throw new Error(`${flag} needs a plain value, got ${JSON.stringify(value)}`);
	}
	return value;
}

/** argv (after `claude`) for an enforced read-only interactive Claude Code session. */
export function claudeReadOnlyArgv(opts: { model?: string; resume?: string } = {}): string[] {
	return [
		...CLAUDE_READ_ONLY_PREFIX,
		...(opts.model ? ["--model", launchValue("--model", opts.model)] : []),
		...(opts.resume ? ["--resume", launchValue("--resume", opts.resume)] : []),
	];
}

/** True only for argv that claudeReadOnlyArgv() could have produced. */
export function claudeArgvIsReadOnly(argv: readonly string[] | null | undefined): boolean {
	if (!argv || argv.length < CLAUDE_READ_ONLY_PREFIX.length) return false;
	if (CLAUDE_READ_ONLY_PREFIX.some((arg, i) => argv[i] !== arg)) return false;
	const rest = argv.slice(CLAUDE_READ_ONLY_PREFIX.length);
	const seen = new Set<string>();
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i], value = rest[i + 1];
		if ((flag !== "--model" && flag !== "--resume") || seen.has(flag)) return false;
		if (value === undefined || value === "" || value.startsWith("-") || /[\r\n]/.test(value)) return false;
		seen.add(flag);
	}
	return true;
}

export interface BridgeArgs {
	name: string;
	project: string;
	pane: string | null;
	replyTimeoutMs: number;
	/** null: Claude is started by the recipe (today's behavior). Else the bridge launches it. */
	launch: { argv: string[] } | null;
}

/** Parse bridge argv. `--model`/`--resume` belong to the read-only launch only. */
export function parseBridgeArgs(argv: string[]): BridgeArgs {
	const name = flagValue(argv, "--name");
	if (!name) throw new Error("--name <peer-name> is required");
	const readOnly = argv.includes("--read-only");
	const model = flagValue(argv, "--model");
	const resume = flagValue(argv, "--resume");
	if (!readOnly && (model !== null || resume !== null)) {
		throw new Error("--model/--resume configure the Claude Code this bridge launches, which it does only with --read-only");
	}
	return {
		name,
		project: flagValue(argv, "--project") ?? "default",
		pane: flagValue(argv, "--pane"),
		replyTimeoutMs: Number(flagValue(argv, "--reply-timeout") ?? DEFAULT_REPLY_TIMEOUT_MS),
		launch: readOnly ? { argv: claudeReadOnlyArgv({ model: model ?? undefined, resume: resume ?? undefined }) } : null,
	};
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
	/**
	 * The argv THIS bridge spawned `claude` with, when it launched Claude itself.
	 * The read-only declaration is derived from it and from nothing else: no
	 * flag, env var or pane state can make a recipe-started Claude read-only.
	 */
	launchedArgv?: readonly string[] | null;
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
		...(claudeArgvIsReadOnly(reg.launchedArgv) ? { read_only: true } : {}),
	};
}

export function bridgeRegistryEntry(
	identity: ComsIdentity,
	live: { now: string; pid: number; queueDepth: number },
): RegistryEntry {
	return buildLiveRegistryEntry(identity, {
		now: live.now,
		pid: live.pid,
		// External context is not observable. Unknown is not a measured zero.
		contextUsedPct: null,
		queueDepth: live.queueDepth,
	});
}

async function main(): Promise<void> {
	let args: BridgeArgs;
	try { args = parseBridgeArgs(process.argv.slice(2)); }
	catch (err) { die(err instanceof Error ? err.message : String(err)); }
	const { name, replyTimeoutMs, launch } = args;
	const rawProject=args.project,roots=sessionRootsFromEnv();
 const project=roots?.mode==="targeted"?projectForSession(rawProject,roots).project:rawProject;
	const paneId = args.pane ?? process.env.HERDR_PANE_ID ?? die("--pane <pane_id> required (or run inside a herdr pane)");
	// A launched Claude inherits THIS terminal, so it can only be in our own pane.
	if (launch && paneId !== process.env.HERDR_PANE_ID) {
		die("--read-only launches Claude Code in this pane; run it inside the herdr pane it bridges (no foreign --pane)");
	}

	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) die(err.message);
		throw err;
	}

	// ── read-only launch: the bridge owns the Claude process ──
	// Foreground child on the pane's terminal (stdio inherit, same process
	// group), started exactly the way exec-at-target.ts starts the recipe's
	// Claude. Its exit ends the bridge, so the declaration lives exactly as long
	// as the restricted process it describes.
	let claude: ChildProcess | null = null;
	let onClaudeExit: (code: number) => void = (code) => { process.exit(code); };
	if (launch) {
		claude = spawn("claude", launch.argv, {
			cwd: roots?.executionRoot ?? process.cwd(),
			env: roots ? targetEnvironment(roots) : process.env,
			stdio: "inherit",
		});
		claude.once("error", (err) => die(`could not launch claude: ${err.message}`));
		claude.once("exit", (code, signal) => onClaudeExit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
	}

	// `_claude-peer` backgrounds this bridge before the shell starts Claude Code.
	// Do not publish a coms identity during that gap: Hub peer readiness is based
	// on registration, and an immediate prompt typed into the still-booting pane
	// is lost while the Claude TUI replaces the shell screen.
	const startup = await waitForClaudePaneReady(async () => (await herdr.paneGet(paneId)).pane);
	if (!startup.ready) {
		// Leave no restricted Claude behind without the bridge that describes it.
		if (claude && claude.exitCode === null) { try { claude.kill("SIGTERM"); } catch { /* already gone */ } }
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
		cwd: executionRoot(process.cwd()),
	};
	const queue = new PromptQueue<PromptEnvelope>();
	const purpose = launch ? "Claude Code (bridged pane, read-only)" : "Claude Code (bridged pane)";

	// Built once — `started_at` is registration time and stays put across every
	// keepalive rebuild below.
	const registryIdentity = bridgeRegistryIdentity({
		sessionId,
		name: uniqueName,
		purpose,
		endpoint: id.endpoint,
		cwd: id.cwd,
		startedAt: nowIso(),
		launchedArgv: claude ? launch!.argv : null,
	});
 if(roots?.mode==='targeted')registryIdentity.targetId=roots.targetId;

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
					context_used_pct: null,
     context_measurement: 'unknown',
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
		await presence.annotate({ name: uniqueName, project, contextUsedPct: null, queueDepth: queue.depth });
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
   await respondToClaudePrompt(env, id, () => driveClaude(env, drivePorts), sendEnvelope);
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

 const drivePorts: ClaudeDrivePorts = {
  paneId, replyTimeoutMs, paneStatus,
  hookSeen: () => hookSeen, markHookSeen: () => { hookSeen = true; },
  readHook: () => {
   try { return { mtime: fs.statSync(hookFile).mtimeMs, raw: fs.readFileSync(hookFile, "utf-8") }; }
   catch { return null; }
  },
  readPane: async () => (await herdr.paneRead({ pane_id: paneId, source: "recent_unwrapped", lines: 200 })).read.text,
  sendText: text => herdr.paneSendText(paneId, text),
  sendEnter: () => herdr.paneSendKeys(paneId, ["enter"]), log: console.error,
 };

	// ── shutdown ──
	let shuttingDown = false;
	function shutdown(code = 0): void {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepalive);
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
		removeRegistryEntry(project, uniqueName);
		if (claude && claude.exitCode === null && claude.signalCode === null) {
			try { claude.kill("SIGTERM"); } catch { /* already gone */ }
		}
		process.exit(code);
	}
	if (claude) {
		onClaudeExit = (code) => shutdown(code);
		// Ctrl+C reaches the whole foreground group; it belongs to the Claude TUI.
		// The bridge follows Claude's exit instead of dying under it.
		process.on("SIGINT", () => { /* Claude decides; its exit ends the bridge */ });
		process.on("SIGHUP", () => shutdown(129));
	} else {
		process.on("SIGINT", () => shutdown());
	}
	process.on("SIGTERM", () => shutdown());
}

export interface ClaudeDrivePorts {
 paneId: string; replyTimeoutMs: number;
 hookSeen(): boolean; markHookSeen(): void;
 readHook(): { mtime: number; raw: string } | null;
 paneStatus(): Promise<string>; readPane(): Promise<string>;
 sendText(text: string): Promise<unknown>; sendEnter(): Promise<unknown>;
 now?(): number; sleep?(ms: number): Promise<void>; log?(text: string): void;
}

// The same emission path is used by the serial production pump and local tests.
export async function respondToClaudePrompt(env: PromptEnvelope, identity: SenderIdentity,
 drive: () => Promise<string>, send: typeof sendEnvelope, log: (text: string) => void = console.error): Promise<void> {
 try { await send(env.sender_endpoint, makeResponseEnvelope(identity, env.msg_id, await drive())); }
 catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isReplyPendingError(err)) log(`coms-claude-bridge: ${env.msg_id} remains pending: ${message}`);
  else { try { await send(env.sender_endpoint, makeResponseEnvelope(identity, env.msg_id, null, message)); }
   catch { log(`coms-claude-bridge: could not deliver error for ${env.msg_id}: ${message}`); } }
 }
}

class AmbiguousReviewWrapError extends Error {}

export async function driveClaude(env: PromptEnvelope, d: ClaudeDrivePorts): Promise<string> {
 const { paneId, replyTimeoutMs, paneStatus } = d;
 const now = d.now ?? Date.now;
 const sleep = d.sleep ?? (async (ms: number) => { await new Promise(r => setTimeout(r, ms)); });
 const requestBoundary = `<<COMS_REQUEST:${env.msg_id}:${ulid()}>>`;
		const sentinelMode = !d.hookSeen();
		// The caller's declared deadline wins over the bridge default (clamped).
		// One absolute deadline covers BOTH idle waiting and the reply; otherwise a
		// two-minute busy wait silently extends the caller's budget.
		const effectiveTimeoutMs = resolveReplyTimeoutMs(env.reply_timeout_ms, replyTimeoutMs);
		const startedAt = now();
		const replyDeadline = replyDeadlineAt(startedAt, effectiveTimeoutMs);

		// Claude Code must be idle-ish before we type into its input box — but a busy
		// pane is a wait, not a failure. Throwing here made every mid-turn moment a
		// hard error and pushed callers into hot-retry loops.
		const waitDeadline = Math.min(replyDeadline, startedAt + idleWaitBudgetMs(effectiveTimeoutMs));
		const waitStarted = startedAt;
		for (let attempt = 0; ; attempt++) {
			if (await paneStatus() !== "working") break;
			const remaining = waitDeadline - now();
			if (remaining <= 0) {
				throw new Error(
					`Claude Code in pane ${paneId} is still mid-turn after waiting ` +
					`${Math.round((now() - waitStarted) / 1000)}s — try again shortly`,
				);
			}
			await sleep(Math.min(idleWaitDelayMs(attempt), remaining));
		}

		// Snapshot immediately before submission, not before a potentially long busy wait.
		const hookMtimeBefore = d.readHook()?.mtime ?? 0;
		try {
			await d.sendText(formatPanePrompt(env, sentinelMode, requestBoundary));
			await sleep(ENTER_DELAY_MS);
			await d.sendEnter();

			// The sender's local await returns `pending` at replyDeadline, but the
			// bridge keeps watching the already-running turn up to the hard cap so a
			// late completion can still resolve the original msg_id.
			const monitorDeadline = replyDeadlineAt(startedAt, REPLY_TIMEOUT_HARD_CAP_MS);
			let pendingLogged = false;
			let sawWorking = false;
			let lastReason: string | undefined;
			function checkReply(text: string, pane = false) {
				if (env.review_protocol !== "v1") return text;
				const frame = parseReview(text, env.msg_id, pane);
				if (frame.wire) return frame.wire;
				if (frame.reason !== lastReason) d.log?.(`Review ${env.msg_id} remains pending (${frame.reason}); expected a standalone final frame`);
				lastReason = frame.reason;
			}
			while (now() < monitorDeadline) {
				await sleep(POLL_MS);
				if (!pendingLogged && now() >= replyDeadline) {
					pendingLogged = true;
					d.log?.(`coms-claude-bridge: ${env.msg_id} exceeded its reply budget and remains pending`);
				}

				// primary: Stop hook wrote a new record
				const hook = d.readHook();
				if (hook) {
					const mtime = hook.mtime;
					if (mtime > hookMtimeBefore) {
						const rec = parseHookRecord(hook.raw);
						if (rec) {
							d.markHookSeen();
							const result = checkReply(rec.text);
							if (result !== undefined) return result;
						}
					}
				}

				const status = await paneStatus();
				if (status === "working") sawWorking = true;
				// fallback: turn ended without a hook record → scrape the sentinel
				if (sentinelMode && sawWorking && (status === "done" || status === "idle")) {
					const text = await d.readPane();
					const reply = env.review_protocol === "v1"
						? extractPaneReview(text, env.msg_id, requestBoundary)
						: extractSentinelReply(text, env.msg_id, requestBoundary);
					if (reply) {
						const result = checkReply(reply, true);
						if (result !== undefined) return result;
						if (lastReason === 'ambiguous_wrap' && now() >= replyDeadline) {
							throw new AmbiguousReviewWrapError("Ambiguous line wrap in the review report; exact Stop hook response unavailable.");
						}
					}
					// sentinel not visible yet — keep polling until deadline
				}
			}
		} catch (error) {
			if (error instanceof AmbiguousReviewWrapError) throw error;
			// After submission a pane/transport error cannot prove that Claude stopped.
			throw new ReplyPendingError(`could not observe completion of the submitted turn: ${error}`);
		}
		throw new ReplyPendingError(
			`no reply from Claude Code before the ${REPLY_TIMEOUT_HARD_CAP_MS}ms hard monitoring cap (requested ${effectiveTimeoutMs}ms)` +
				(sentinelMode ? " (Stop hook not installed? see .pi/agent-fleet/hooks/coms-stop-hook.mjs)" : ""),
		);
	}


const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
