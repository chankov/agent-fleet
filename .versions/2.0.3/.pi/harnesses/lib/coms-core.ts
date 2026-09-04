import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { buildLiveRegistryEntry } from "./coms-registry-entry.ts";
import {
	HerdrAgentWatch,
	HerdrPresence,
	herdrPaneId,
	herdrPresenceAvailable,
	peerNameFrom,
	type HerdrAgentInfo,
} from "./herdr-presence.ts";
import {
	COMS_DIR,
	KEEPALIVE_INTERVAL_MS,
	LINE_CAP_BYTES,
	MAX_HOPS,
	PING_INTERVAL_MS,
	TIMEOUT_MS,
	bindEndpoint,
	fallbackColor,
	isValidHex,
	listProjects,
	makeEndpoint,
	nowIso,
	projectAgentsDir,
	pruneDeadEntries,
	pruneDeadEntriesAllProjects,
	readCliFlags,
	readFrontmatterFromArgv,
	removeRegistryEntry,
	resolveUniqueName,
	sendEnvelope,
	ulid,
	writeRegistryAtomic,
	type AgentCard,
	type ComsIdentity,
	type InboundContext,
	type PendingReply,
	type PeerStatus,
	type PingEnvelope,
	type Pong,
	type PromptEnvelope,
	type RegistryEntry,
	type ResponseEnvelope,
} from "./coms-core-io.ts";

export * from "./coms-core-io.ts";

export interface ComsListParams {
	project?: string;
	include_explicit?: boolean;
}

export interface ComsSendParams {
	target: string;
	prompt: string;
	conversation_id?: string | null;
	response_schema?: object | null;
	reply_timeout_ms?: number | null;
}

export interface ComsSendResult {
	msg_id: string;
	target: string;
	target_session: string;
	hops: number;
	promise: PendingReply["promise"];
}

export interface ComsListResult {
	agents: Array<{
		name: string;
		session_id: string;
		purpose: string;
		model: string;
		cwd: string;
		project: string;
		alive: boolean;
		context_used_pct: number | null;
		pane_id: string | null;
		status: PeerStatus | null;
		queue_depth: number | null;
		color: string;
	}>;
	project: string;
	scoped: true;
	widenRequested: boolean;
}

export interface CreateComsPeerDeps {
	pi: ExtensionAPI;
	getContext: () => ExtensionContext | null;
	onPeersChanged?: () => void;
	acceptInbound?: () => string | null;
	handleCustomEnvelope?: (socket: net.Socket, envelope: any) => boolean;
}

export interface ConnectComsOptions {
	ctx: ExtensionContext;
	defaultNamePrefix: string;
	defaultPurpose: string;
}

export type ComsConnectStage = "dirs" | "bind" | "registry";

export class ComsConnectError extends Error {
	readonly stage: ComsConnectStage;

	constructor(stage: ComsConnectStage, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "ComsConnectError";
		this.stage = stage;
	}
}

export function createComsPeer(deps: CreateComsPeerDeps) {
	const { pi } = deps;
	const peerCards = new Map<string, AgentCard & { staleCount: number }>();
	const pendingReplies = new Map<string, PendingReply>();
	const inboundQueue = new Map<string, InboundContext>();
	const scope = { includeExplicit: false, displayProject: null as string | null };
	let identity: ComsIdentity | null = null;
	let currentInbound: InboundContext | null = null;
	let server: net.Server | null = null;
	let pingTimer: NodeJS.Timeout | null = null;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let herdrPresence: HerdrPresence | null = null;
	let herdrWatch: HerdrAgentWatch | null = null;
	let turnState: "idle" | "working" = "idle";
	let shuttingDown = false;

	const changed = () => deps.onPeersChanged?.();
	const audit = (entry: Record<string, unknown>) => {
		try { pi.appendEntry("coms-log", entry); } catch { /* best effort */ }
	};
	const ack = (socket: net.Socket, msgId: string) => {
		try { socket.write(`${JSON.stringify({ type: "ack", msg_id: msgId })}\n`); } catch { /* ignore */ }
		try { socket.end(); } catch { /* ignore */ }
	};
	const nack = (socket: net.Socket, msgId: string, error: string) => {
		try { socket.write(`${JSON.stringify({ type: "nack", msg_id: msgId, error })}\n`); } catch { /* ignore */ }
		try { socket.end(); } catch { /* ignore */ }
	};

	function peersInScope(): RegistryEntry[] {
		if (!identity) return [];
		const filter = scope.displayProject ?? identity.project;
		const entries = filter === "*" ? pruneDeadEntriesAllProjects() : pruneDeadEntries(filter);
		return entries.filter(entry => entry.session_id !== identity!.session_id && (scope.includeExplicit || !entry.explicit));
	}

	function resolveTarget(target: string): RegistryEntry | null {
		const entries = peersInScope();
		return entries.find(entry => entry.name === target) ?? entries.find(entry => entry.session_id === target) ?? null;
	}

	function herdrSyncPeerCards(agents: HerdrAgentInfo[]): void {
		if (!identity) return;
		const liveNames = new Set(agents.map(peerNameFrom).filter((name): name is string => !!name));
		const liveSessions = new Set<string>();
		let didChange = false;
		for (const entry of peersInScope()) {
			if (!liveNames.has(entry.name)) continue;
			liveSessions.add(entry.session_id);
			const next = {
				name: entry.name, purpose: entry.purpose, model: entry.model, color: entry.color,
				context_used_pct: entry.context_used_pct ?? 0, queue_depth: entry.queue_depth ?? 0, staleCount: 0,
			};
			const previous = peerCards.get(entry.session_id);
			if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
				peerCards.set(entry.session_id, next);
				didChange = true;
			}
		}
		for (const sessionId of [...peerCards.keys()]) {
			if (sessionId !== identity.session_id && !liveSessions.has(sessionId)) {
				peerCards.delete(sessionId);
				didChange = true;
			}
		}
		if (didChange) changed();
	}

	function handlePrompt(socket: net.Socket, envelope: PromptEnvelope): void {
		const refusal = deps.acceptInbound?.();
		if (refusal) { nack(socket, envelope.msg_id, refusal); return; }
		if (typeof envelope.hops !== "number" || envelope.hops >= MAX_HOPS) {
			nack(socket, envelope.msg_id, "hops exceeded");
			return;
		}
		const inbound: InboundContext = {
			msg_id: envelope.msg_id,
			hops: envelope.hops,
			sender_endpoint: envelope.sender_endpoint,
			sender_session: envelope.sender_session,
			response_schema: envelope.response_schema ?? null,
			fulfilled: false,
		};
		inboundQueue.set(envelope.msg_id, inbound);
		currentInbound = inbound;
		try {
			pi.sendMessage({
				customType: "coms-inbound",
				content: `[from ${envelope.sender_name} @ ${envelope.sender_cwd}]\n\n${envelope.prompt}`,
				display: true,
				details: { msg_id: envelope.msg_id, sender_session: envelope.sender_session, response_schema: envelope.response_schema ?? null },
			}, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			inboundQueue.delete(envelope.msg_id);
			currentInbound = null;
			nack(socket, envelope.msg_id, "internal error");
			return;
		}
		ack(socket, envelope.msg_id);
		audit({ event: "inbound_prompt", msg_id: envelope.msg_id, sender: envelope.sender_session, hops: envelope.hops });
	}

	function handleResponse(socket: net.Socket, envelope: ResponseEnvelope): void {
		const pending = pendingReplies.get(envelope.msg_id);
		if (pending) {
			if (pending.timer) { try { clearTimeout(pending.timer); } catch { /* ignore */ } pending.timer = null; }
			pending.result = { response: envelope.response, error: envelope.error ?? null };
			try { pending.resolve(pending.result); } catch { /* ignore */ }
		} else {
			audit({ event: "orphan_response", msg_id: envelope.msg_id });
		}
		ack(socket, envelope.msg_id);
	}

	function handlePing(socket: net.Socket, envelope: PingEnvelope): void {
		const ctx = deps.getContext();
		const card: AgentCard = {
			name: identity?.name ?? "unknown",
			purpose: identity?.purpose ?? "",
			model: ctx?.model?.id ?? identity?.model ?? "unknown",
			color: identity?.color ?? "#36F9F6",
			context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
			queue_depth: inboundQueue.size,
			pane_id: herdrPaneId() ?? null,
			status: turnState === "working" || inboundQueue.size > 0 ? "working" : "idle",
		};
		try { socket.write(`${JSON.stringify({ type: "pong", msg_id: envelope.msg_id, agent_card: card })}\n`); } catch { /* ignore */ }
		try { socket.end(); } catch { /* ignore */ }
	}

	function connectionHandler(socket: net.Socket): void {
		let buffer = "";
		let handled = false;
		const onData = (chunk: Buffer) => {
			if (handled) return;
			buffer += chunk.toString("utf8");
			if (buffer.length > LINE_CAP_BYTES) {
				handled = true;
				socket.removeListener("data", onData);
				nack(socket, "", "malformed envelope");
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			socket.removeListener("data", onData);
			let parsed: any;
			try { parsed = JSON.parse(buffer.slice(0, newline)); } catch { nack(socket, "", "malformed envelope"); return; }
			if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string" || typeof parsed.msg_id !== "string" || typeof parsed.sender_session !== "string" || typeof parsed.sender_endpoint !== "string") {
				nack(socket, typeof parsed?.msg_id === "string" ? parsed.msg_id : "", "malformed envelope");
				return;
			}
			try {
				if (parsed.type === "prompt") handlePrompt(socket, parsed);
				else if (parsed.type === "response") handleResponse(socket, parsed);
				else if (parsed.type === "ping") handlePing(socket, parsed);
				else if (!deps.handleCustomEnvelope?.(socket, parsed)) nack(socket, parsed.msg_id, "unknown type");
			} catch {
				nack(socket, parsed.msg_id, "internal error");
			}
		};
		socket.on("data", onData);
		socket.once("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
	}

	function writeLiveRegistry(): void {
		if (!identity) return;
		const ctx = deps.getContext();
		try {
			writeRegistryAtomic(buildLiveRegistryEntry(identity, {
				now: nowIso(), pid: process.pid, model: ctx?.model?.id,
				contextUsedPct: ctx?.getContextUsage()?.percent, queueDepth: inboundQueue.size,
			}), identity.project);
		} catch { /* best effort */ }
	}

	async function refresh(): Promise<void> {
		if (!identity) return;
		const peers = peersInScope();
		const results = await Promise.allSettled(peers.map(async entry => {
			const pong = await sendEnvelope(entry.endpoint, {
				type: "ping", msg_id: ulid(), sender_session: identity!.session_id,
				sender_endpoint: identity!.endpoint, hops: 0, timestamp: nowIso(),
			} as PingEnvelope);
			return { entry, pong: pong as Pong };
		}));
		const seen = new Set<string>();
		let didChange = false;
		for (const result of results) {
			if (result.status !== "fulfilled" || !result.value.pong?.agent_card) continue;
			seen.add(result.value.entry.session_id);
			const next = { ...result.value.pong.agent_card, staleCount: 0 };
			const previous = peerCards.get(result.value.entry.session_id);
			if (!previous || JSON.stringify({ ...previous, staleCount: 0 }) !== JSON.stringify(next)) {
				peerCards.set(result.value.entry.session_id, next);
				didChange = true;
			}
		}
		for (const [sessionId, card] of peerCards) {
			if (sessionId === identity.session_id || seen.has(sessionId)) continue;
			card.staleCount = (card.staleCount ?? 0) + 1;
			if (card.staleCount > 6) peerCards.delete(sessionId);
			didChange = true;
		}
		if (didChange) changed();
	}

	async function ping(endpoint: string): Promise<AgentCard | null> {
		if (!identity) return null;
		try {
			const response = await sendEnvelope(endpoint, {
				type: "ping", msg_id: ulid(), sender_session: identity.session_id,
				sender_endpoint: identity.endpoint, hops: 0, timestamp: nowIso(),
			} as PingEnvelope);
			return response?.type === "pong" && response.agent_card ? response.agent_card : null;
		} catch { return null; }
	}

	async function connect(options: ConnectComsOptions): Promise<ComsIdentity> {
		if (identity) return identity;
		shuttingDown = false;
		const flags = readCliFlags(pi);
		const frontmatter = readFrontmatterFromArgv(process.argv);
		const project = flags.project || "default";
		const sessionId = ulid();
		const sessionName = typeof pi.getSessionName === "function" ? pi.getSessionName() || undefined : undefined;
		const desiredName = flags.name || sessionName || frontmatter.name || `${options.defaultNamePrefix}-${sessionId.slice(-6)}`;
		const name = resolveUniqueName(project, desiredName);
		if (name !== desiredName) audit({ event: "name_collision", desired: desiredName, assigned: name, project });
		let color = fallbackColor(sessionId);
		if (frontmatter.color && isValidHex(frontmatter.color)) color = frontmatter.color;
		if (flags.color && isValidHex(flags.color)) color = flags.color;
		const endpoint = makeEndpoint(sessionId);
		const cwd = options.ctx.cwd || process.cwd();
		const model = options.ctx.model?.id ?? "unknown";
		const purpose = flags.purpose || frontmatter.description || options.defaultPurpose;
		try {
			fs.mkdirSync(projectAgentsDir(project), { recursive: true });
			if (process.platform !== "win32") {
				fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
				try { fs.chmodSync(COMS_DIR, 0o700); } catch { /* best effort */ }
			}
		} catch (error) {
			throw new ComsConnectError("dirs", error);
		}
		try { server = await bindEndpoint(endpoint, connectionHandler); }
		catch (error) { throw new ComsConnectError("bind", error); }
		const startedAt = nowIso();
		const entry: RegistryEntry = {
			session_id: sessionId, name, purpose, model, color, pid: process.pid,
			endpoint, cwd, started_at: startedAt, explicit: flags.explicit === true, version: 1,
		};
		let registryFile: string;
		try { registryFile = writeRegistryAtomic(entry, project); }
		catch (error) {
			try { server.close(); } catch { /* ignore */ }
			server = null;
			throw new ComsConnectError("registry", error);
		}
		identity = {
			session_id: sessionId, name, purpose, color, project, explicit: flags.explicit === true,
			cwd, model, endpoint, registryFile, started_at: startedAt,
		};
		scope.includeExplicit = false;
		scope.displayProject = project;
		audit({ event: "boot", session_id: sessionId, name, project });

		const useHerdr = await herdrPresenceAvailable();
		if (useHerdr) {
			const paneId = herdrPaneId()!;
			herdrPresence = new HerdrPresence({
				paneId,
				source: `coms:${sessionId}`,
				onError: (error, dialect) => audit({ event: "presence_dialect_rejected", dialect, reason: error?.message ?? String(error) }),
			});
			void herdrPresence.report("idle", { name, project, contextUsedPct: 0, queueDepth: 0 });
			herdrWatch = new HerdrAgentWatch({ ownPaneId: paneId, onChange: herdrSyncPeerCards });
			void herdrWatch.start();
			audit({ event: "presence_backend", backend: "herdr", pane: paneId });
		} else {
			pingTimer = setInterval(() => { void refresh(); }, PING_INTERVAL_MS);
			try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
		}
		keepaliveTimer = setInterval(() => {
			if (!identity) return;
			const missing = !fs.existsSync(identity.registryFile);
			writeLiveRegistry();
			if (missing) {
				audit({ event: "self_heal", session_id: identity.session_id, reason: "registry file missing" });
				if (!fs.existsSync(identity.registryFile)) writeLiveRegistry();
			}
			if (herdrPresence) {
				void herdrPresence.report(turnState, {
					name: identity.name, project: identity.project,
					contextUsedPct: Math.round(deps.getContext()?.getContextUsage()?.percent ?? 0), queueDepth: inboundQueue.size,
				});
			}
			if (herdrWatch) herdrSyncPeerCards(herdrWatch.current());
		}, KEEPALIVE_INTERVAL_MS);
		try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }
		if (!useHerdr) void refresh();
		return identity;
	}

	async function list(params: ComsListParams = {}): Promise<ComsListResult> {
		if (!identity) return { agents: [], project: "default", scoped: true, widenRequested: false };
		const scopeProject = scope.displayProject ?? identity.project;
		let widened = false;
		let projects: string[];
		if (scopeProject === "*") projects = params.project && params.project !== "*" ? [params.project] : listProjects();
		else {
			projects = [scopeProject];
			if (params.project && params.project !== scopeProject) widened = true;
		}
		const includeExplicit = scope.includeExplicit && params.include_explicit !== false;
		if (params.include_explicit === true && !scope.includeExplicit) widened = true;
		const collected: Array<{ entry: RegistryEntry; project: string }> = [];
		for (const project of projects) {
			for (const entry of pruneDeadEntries(project)) {
				if (entry.explicit && !includeExplicit) continue;
				if (entry.session_id !== identity.session_id) collected.push({ entry, project });
			}
		}
		const pongs = await Promise.allSettled(collected.map(item => ping(item.entry.endpoint)));
		const agents = collected.map((item, index) => {
			const result = pongs[index];
			const pong = result.status === "fulfilled" ? result.value : null;
			return {
				name: item.entry.name, session_id: item.entry.session_id, purpose: item.entry.purpose,
				model: item.entry.model, cwd: item.entry.cwd, project: item.project, alive: pong !== null,
				context_used_pct: pong?.context_used_pct ?? null, pane_id: pong?.pane_id ?? null,
				status: pong?.status ?? null, queue_depth: pong?.queue_depth ?? null, color: item.entry.color,
			};
		});
		return { agents, project: scopeProject, scoped: true, widenRequested: widened };
	}

	async function send(params: ComsSendParams, auditExtra: Record<string, unknown> = {}): Promise<ComsSendResult> {
		if (!identity) throw new Error("coms not initialised");
		const target = resolveTarget(params.target);
		if (!target) {
			const project = scope.displayProject ?? identity.project;
			throw new Error(`coms: no connected peer "${params.target}" in your pool (project ${project}). Only peers shown in the coms pool are reachable. If you expected this peer, ask the human to widen scope with /af-coms --project <name> or /af-coms --all, then retry.`);
		}
		const hops = currentInbound ? currentInbound.hops + 1 : 0;
		if (hops >= MAX_HOPS) throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
		const msgId = ulid();
		await sendEnvelope(target.endpoint, {
			type: "prompt", msg_id: msgId, sender_session: identity.session_id, sender_endpoint: identity.endpoint,
			sender_name: identity.name, sender_cwd: identity.cwd, hops, timestamp: nowIso(), prompt: params.prompt,
			conversation_id: params.conversation_id ?? null, response_schema: params.response_schema ?? null,
			reply_timeout_ms: params.reply_timeout_ms ?? null,
		} as PromptEnvelope);
		let resolve!: PendingReply["resolve"];
		let reject!: PendingReply["reject"];
		const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => { resolve = res; reject = rej; });
		pendingReplies.set(msgId, { resolve, reject, timer: null, promise, target_name: target.name, created_at: nowIso() });
		audit({ event: "outbound_prompt", msg_id: msgId, target: target.name, hops, ...auditExtra });
		return { msg_id: msgId, target: target.name, target_session: target.session_id, hops, promise };
	}

	function get(msgId: string): { status: "pending" | "complete" | "error"; response?: any; error?: string | null } {
		const entry = pendingReplies.get(msgId);
		if (!entry) return { status: "error", error: "unknown msg_id" };
		if (!entry.result) return { status: "pending" };
		return { status: "complete", response: entry.result.response, error: entry.result.error ?? null };
	}

	async function awaitReply(msgId: string, timeoutMs = TIMEOUT_MS): Promise<{ status: "pending" | "complete" | "error"; response?: any; error?: string | null }> {
		const entry = pendingReplies.get(msgId);
		if (!entry) return { status: "error", error: "unknown msg_id" };
		const timeout = new Promise<{ error: "timeout" }>(resolve => {
			const timer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
			try { (timer as any).unref?.(); } catch { /* ignore */ }
		});
		const result = await Promise.race([entry.promise, timeout]);
		if (result.error === "timeout") return { status: "pending" };
		if (result.error) return { status: "error", error: result.error };
		return { status: "complete", response: result.response };
	}

	async function respond(ctx: ExtensionContext): Promise<void> {
		const inbound = [...inboundQueue.values()].reverse().find(item => !item.fulfilled);
		if (!inbound || !identity) return;
		let text = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message as any;
			text = typeof message.content === "string"
				? message.content
				: Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n") : text;
		}
		let response: any = text;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try { response = JSON.parse(text); } catch { response = null; error = "response not valid JSON"; }
		}
		try {
			await sendEnvelope(inbound.sender_endpoint, {
				type: "response", msg_id: inbound.msg_id, sender_session: identity.session_id,
				sender_endpoint: identity.endpoint, hops: 0, timestamp: nowIso(), response, error,
			} as ResponseEnvelope);
			audit({ event: "outbound_response", msg_id: inbound.msg_id, error });
		} catch (sendError: any) {
			audit({ event: "outbound_response_failed", msg_id: inbound.msg_id, reason: sendError?.message ?? String(sendError) });
		}
		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		if (currentInbound?.msg_id === inbound.msg_id) currentInbound = null;
	}

	async function setTurnState(state: "idle" | "working"): Promise<void> {
		turnState = state;
		if (!herdrPresence || !identity) return;
		void herdrPresence.report(state, {
			name: identity.name, project: identity.project,
			contextUsedPct: Math.round(deps.getContext()?.getContextUsage()?.percent ?? 0), queueDepth: inboundQueue.size,
		});
	}

	async function updateScope(args: string, ctx?: ExtensionContext): Promise<void> {
		if (args.includes("--all")) {
			scope.includeExplicit = !scope.includeExplicit;
			try { ctx?.ui.notify(`coms: include_explicit = ${scope.includeExplicit}`, "info"); } catch { /* ignore */ }
		}
		const projectMatch = args.match(/--project\s+(\S+)/);
		if (projectMatch) {
			scope.displayProject = projectMatch[1];
			try { ctx?.ui.notify(`coms: displaying project ${scope.displayProject}`, "info"); } catch { /* ignore */ }
		}
		if (herdrWatch) await herdrWatch.start();
		else await refresh();
	}

	async function shutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		if (herdrWatch) { try { herdrWatch.stop(); } catch { /* ignore */ } herdrWatch = null; }
		if (herdrPresence) { try { void herdrPresence.release(); } catch { /* ignore */ } herdrPresence = null; }
		if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
		if (identity) {
			if (process.platform !== "win32") { try { fs.unlinkSync(identity.endpoint); } catch { /* ignore */ } }
			removeRegistryEntry(identity.project, identity.name);
			audit({ event: "shutdown", session_id: identity.session_id });
		}
	}

	return {
		connect, send, list, get, await: awaitReply, refresh, respond, shutdown,
		setTurnState, updateScope, writeLiveRegistry, ping, peersInScope, resolveTarget,
		peerCards, pendingReplies, inboundQueue, scope,
		get identity() { return identity; },
		get ready() { return identity !== null && server !== null; },
	};
}

export type ComsPeer = ReturnType<typeof createComsPeer>;
