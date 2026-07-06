// .pi/harnesses/lib/herdr-client.ts
//
// The one shared client for the herdr socket API (https://herdr.dev/docs/socket-api/).
// Every file in this repo that talks to herdr goes through this module — no other
// file opens the socket directly.
//
// Wire facts this client is built on (validated live against herdr 0.7.1,
// protocol 14 — see docs/plans/herdr/spike-notes.md):
// - ndjson over a unix socket; the server closes the connection after each
//   response, so request() opens a fresh connection per call.
// - events.subscribe is the exception: the connection stays open and streams
//   `{"event":…,"data":…}` lines after a `subscription_started` ack.
// - Unknown request params are SILENTLY IGNORED by the server (e.g. `pane_id`
//   instead of `target_pane_id` on pane.split retargets the focused pane) —
//   the typed wrappers below exist so callers never hand-write param names.
// - Parse-level errors come back with an empty id; with one request in flight
//   per connection they are safely attributed to that request.
//
// No pi imports; plain Node stdlib; erasable-TS only (runs under node --test).

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface HerdrErrorShape {
	code: string;
	message: string;
}

export class HerdrRequestError extends Error {
	code: string;
	constructor(err: HerdrErrorShape) {
		super(`herdr: ${err.code}: ${err.message}`);
		this.name = "HerdrRequestError";
		this.code = err.code;
	}
}

export class HerdrUnavailableError extends Error {
	socketPath: string;
	constructor(socketPath: string, cause: string) {
		super(
			`herdr is not running or unreachable (socket: ${socketPath}): ${cause}\n` +
				`Start herdr first (run \`herdr\` in a terminal), or point HERDR_SOCKET_PATH at a running server.`,
		);
		this.name = "HerdrUnavailableError";
		this.socketPath = socketPath;
	}
}

export interface HerdrClientOptions {
	socketPath?: string;
	timeoutMs?: number;
}

export interface PongInfo {
	type: "pong";
	version: string;
	protocol: number;
	capabilities?: Record<string, unknown>;
	[key: string]: unknown;
}

// Minimum server the fleet features are validated against (spike: 0.7.1 / protocol 14).
export const MIN_PROTOCOL = 14;
const DEFAULT_TIMEOUT_MS = 5000;

// Resolution order: explicit arg → HERDR_SOCKET_PATH (set inside every herdr
// pane) → the default-session socket. Named sessions always export
// HERDR_SOCKET_PATH into their panes, so the env var covers them.
export function resolveSocketPath(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
	return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

interface WireResponse {
	id?: string;
	result?: Record<string, unknown>;
	error?: HerdrErrorShape;
	event?: string;
	data?: unknown;
}

let nextId = 0;

// One request → one connection → one response line. Resolves with the raw
// `result` object (unknown fields pass through untouched); rejects with
// HerdrRequestError on an error envelope, HerdrUnavailableError when the
// socket cannot be reached, and a plain Error on timeout.
export function request<T = Record<string, unknown>>(
	method: string,
	params: Record<string, unknown> = {},
	opts: HerdrClientOptions = {},
): Promise<T> {
	const socketPath = resolveSocketPath(opts.socketPath);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const id = `as-${process.pid}-${++nextId}`;

	return new Promise<T>((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		let buf = "";
		let settled = false;
		const timer = setTimeout(() => {
			finish(() => reject(new Error(`herdr: timeout after ${timeoutMs}ms waiting for ${method}`)));
		}, timeoutMs);

		function finish(f: () => void): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			f();
		}

		sock.on("connect", () => {
			sock.write(JSON.stringify({ id, method, params }) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				let msg: WireResponse;
				try {
					msg = JSON.parse(line);
				} catch {
					continue; // not ours; keep reading until timeout
				}
				// Parse errors arrive with an empty id — with one in-flight request
				// per connection they belong to us. Ignore lines for other ids.
				if (msg.error && (msg.id === id || msg.id === "" || msg.id === undefined)) {
					finish(() => reject(new HerdrRequestError(msg.error as HerdrErrorShape)));
					return;
				}
				if (msg.id === id && msg.result !== undefined) {
					finish(() => resolve(msg.result as T));
					return;
				}
			}
		});
		sock.on("error", (err) => {
			finish(() => reject(new HerdrUnavailableError(socketPath, err.message)));
		});
		sock.on("close", () => {
			finish(() => reject(new Error(`herdr: connection closed before a response to ${method}`)));
		});
	});
}

// Ping and return server info, or null when herdr is not reachable/answering.
export async function herdrAvailable(opts: HerdrClientOptions = {}): Promise<PongInfo | null> {
	try {
		const pong = await request<PongInfo>("ping", {}, { timeoutMs: 2000, ...opts });
		return pong && pong.type === "pong" ? pong : null;
	} catch {
		return null;
	}
}

// Fail-fast helper used by every fleet entrypoint: resolves with the pong,
// throws HerdrUnavailableError with an actionable message otherwise.
export async function requireHerdr(opts: HerdrClientOptions = {}): Promise<PongInfo> {
	const socketPath = resolveSocketPath(opts.socketPath);
	const pong = await herdrAvailable(opts);
	if (!pong) throw new HerdrUnavailableError(socketPath, "no server answered ping");
	if (typeof pong.protocol === "number" && pong.protocol < MIN_PROTOCOL) {
		throw new HerdrUnavailableError(
			socketPath,
			`server protocol ${pong.protocol} is older than the minimum tested protocol ${MIN_PROTOCOL} — update herdr`,
		);
	}
	return pong;
}

// ---------------------------------------------------------------- events

// Global topics subscribe as {type}; pane.agent_status_changed and
// pane.output_matched additionally REQUIRE a concrete pane_id (no wildcard).
export type Subscription = { type: string; [key: string]: unknown };

export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

export interface SubscribeHandle {
	close(): void;
}

export interface SubscribeOptions extends HerdrClientOptions {
	// Called when the stream (re)establishes — subscriptions are re-sent
	// automatically; use this to reconcile state missed while disconnected.
	onConnect?: () => void;
	onError?: (err: Error) => void;
	reconnectDelayMs?: number;
}

// Long-lived event stream with auto-reconnect. The returned handle's close()
// stops both the stream and any pending reconnect.
export function subscribe(
	subscriptions: Subscription[],
	onEvent: (ev: HerdrEvent) => void,
	opts: SubscribeOptions = {},
): SubscribeHandle {
	const socketPath = resolveSocketPath(opts.socketPath);
	const reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
	let sock: net.Socket | null = null;
	let closed = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	function connect(): void {
		if (closed) return;
		let buf = "";
		let acked = false;
		sock = net.createConnection(socketPath);
		sock.on("connect", () => {
			sock?.write(
				JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n",
			);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				let msg: WireResponse;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (!acked && msg.result && (msg.result as { type?: string }).type === "subscription_started") {
					acked = true;
					opts.onConnect?.();
					continue;
				}
				if (!acked && msg.error) {
					opts.onError?.(new HerdrRequestError(msg.error));
					// A rejected subscription will not fix itself by retrying.
					closed = true;
					sock?.destroy();
					return;
				}
				if (msg.event) {
					onEvent({ event: msg.event, data: (msg.data ?? {}) as Record<string, unknown> });
				}
			}
		});
		const scheduleReconnect = () => {
			if (closed || retryTimer) return;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				connect();
			}, reconnectDelayMs);
		};
		sock.on("error", (err) => {
			opts.onError?.(err);
			sock?.destroy();
			scheduleReconnect();
		});
		sock.on("close", scheduleReconnect);
	}

	connect();
	return {
		close() {
			closed = true;
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			sock?.destroy();
			sock = null;
		},
	};
}

// ---------------------------------------------------------------- typed wrappers
//
// Thin, param-name-exact wrappers for the methods this repo uses. Response
// types capture the fields we rely on; everything else passes through.

export interface WorkspaceInfo {
	workspace_id: string;
	number?: number;
	label?: string;
	focused?: boolean;
	pane_count?: number;
	tab_count?: number;
	active_tab_id?: string;
	agent_status?: string;
	[key: string]: unknown;
}

export interface PaneInfo {
	pane_id: string;
	terminal_id?: string;
	workspace_id?: string;
	tab_id?: string;
	focused?: boolean;
	cwd?: string;
	label?: string;
	agent?: string;
	agent_status?: string;
	agent_session?: { source?: string; agent?: string; kind?: string; value?: string };
	[key: string]: unknown;
}

// Layout tree nodes for layout.apply: `command` is an ARGV ARRAY (a string is
// rejected by the server); layout.apply creates a NEW tab in the workspace.
export type LayoutNode =
	| {
			type: "pane";
			command?: string[];
			cwd?: string;
			label?: string;
			env?: Record<string, string>;
			pane_id?: string;
	  }
	| {
			type: "split";
			direction: "right" | "down";
			ratio?: number;
			first: LayoutNode;
			second: LayoutNode;
	  };

export const herdr = {
	ping: (opts?: HerdrClientOptions) => request<PongInfo>("ping", {}, opts),

	workspaceCreate: (
		params: { label?: string; cwd?: string; env?: Record<string, string>; focus?: boolean },
		opts?: HerdrClientOptions,
	) =>
		request<{ workspace: WorkspaceInfo; tab: Record<string, unknown>; root_pane: PaneInfo }>(
			"workspace.create",
			params,
			opts,
		),
	workspaceList: (opts?: HerdrClientOptions) =>
		request<{ workspaces: WorkspaceInfo[] }>("workspace.list", {}, opts),
	workspaceFocus: (workspace_id: string, opts?: HerdrClientOptions) =>
		request("workspace.focus", { workspace_id }, opts),
	workspaceRename: (workspace_id: string, label: string, opts?: HerdrClientOptions) =>
		request("workspace.rename", { workspace_id, label }, opts),
	workspaceClose: (workspace_id: string, opts?: HerdrClientOptions) =>
		request("workspace.close", { workspace_id }, opts),

	// NOTE: the target field is `target_pane_id` — `pane_id` would be silently
	// ignored and the FOCUSED pane split instead (spike finding).
	paneSplit: (
		params: {
			target_pane_id: string;
			direction: "right" | "down";
			ratio?: number;
			cwd?: string;
			env?: Record<string, string>;
			focus?: boolean;
			command?: string[];
		},
		opts?: HerdrClientOptions,
	) => request<{ pane: PaneInfo }>("pane.split", params, opts),
	paneRename: (pane_id: string, label: string, opts?: HerdrClientOptions) =>
		request<{ pane: PaneInfo }>("pane.rename", { pane_id, label }, opts),
	paneSendText: (pane_id: string, text: string, opts?: HerdrClientOptions) =>
		request("pane.send_text", { pane_id, text }, opts),
	paneSendKeys: (pane_id: string, keys: string[], opts?: HerdrClientOptions) =>
		request("pane.send_keys", { pane_id, keys }, opts),
	paneRead: (
		params: {
			pane_id: string;
			source?: "visible" | "recent" | "recent_unwrapped" | "detection";
			lines?: number;
			format?: "text" | "ansi";
			strip_ansi?: boolean;
		},
		opts?: HerdrClientOptions,
	) =>
		request<{ read: { pane_id: string; text: string; truncated?: boolean; [key: string]: unknown } }>(
			"pane.read",
			{ source: "recent", format: "text", strip_ansi: true, ...params },
			opts,
		),
	paneGet: (pane_id: string, opts?: HerdrClientOptions) =>
		request<{ pane: PaneInfo }>("pane.get", { pane_id }, opts),
	paneList: (params: { workspace_id?: string } = {}, opts?: HerdrClientOptions) =>
		request<{ panes: PaneInfo[] }>("pane.list", params, opts),
	paneClose: (pane_id: string, opts?: HerdrClientOptions) =>
		request("pane.close", { pane_id }, opts),
	// `source` is REQUIRED (client identity herdr uses to arbitrate authority).
	paneReportAgent: (
		params: {
			pane_id: string;
			source: string;
			agent: string;
			state: "idle" | "working" | "blocked" | "unknown";
			message?: string;
			custom_status?: string;
			seq?: number;
			agent_session_id?: string;
			agent_session_path?: string;
		},
		opts?: HerdrClientOptions,
	) => request("pane.report_agent", params, opts),
	paneReleaseAgent: (
		params: { pane_id: string; source: string; agent: string; seq?: number },
		opts?: HerdrClientOptions,
	) => request("pane.release_agent", params, opts),

	agentList: (opts?: HerdrClientOptions) =>
		request<{ agents: Array<Record<string, unknown>> }>("agent.list", {}, opts),
	agentRead: (
		params: { target: string; source?: string; lines?: number },
		opts?: HerdrClientOptions,
	) => request("agent.read", params, opts),

	layoutApply: (
		params: { workspace_id?: string; root: LayoutNode },
		opts?: HerdrClientOptions,
	) =>
		request<{ layout: { workspace_id: string; tab_id: string; root: unknown } }>(
			"layout.apply",
			params,
			opts,
		),
	layoutExport: (params: Record<string, unknown> = {}, opts?: HerdrClientOptions) =>
		request<{ layout: Record<string, unknown> }>("layout.export", params, opts),

	notificationShow: (
		params: { title?: string; body?: string; [key: string]: unknown },
		opts?: HerdrClientOptions,
	) => request("notification.show", params, opts),

	subscribe,
};
