// ask-user-remote harness
//
// Captures the stock pi-ask-user `ask_user` tool, then registers a wrapper with
// the same schema/renderers/result shape. With no live `user-remote` coms peer
// it delegates to stock execute with the original arguments unchanged. When the
// peer is live, it races the stock local UI against a remote coms round trip.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { raceAskUser } from "./race-core.js";

interface ToolRegistration {
	name: string;
	execute?: (...args: any[]) => Promise<any> | any;
	[key: string]: any;
}

interface ExtensionLike {
	registerTool: (tool: ToolRegistration) => void;
	[key: string]: any;
}

interface InstallOptions {
	stockFactory?: (pi: ExtensionLike) => void;
	startRemote?: (params: any, ctx?: any) => Promise<{ qid: string; result: Promise<any> } | null> | { qid: string; result: Promise<any> } | null;
	cancelRemote?: (qid: string, reason: string) => Promise<void> | void;
	warn?: (message: string) => void;
	createAbortController?: () => AbortController;
	settingsPaths?: string[];
}

// A stock `pi-ask-user` package listed in pi settings is loaded by pi core
// itself, outside this harness's try/catch. If the harness registers `ask_user`
// first, the package's later registration makes pi core hard-crash the session
// with a tool-name conflict. The preflight below detects that configuration and
// skips the wrapper entirely, so the stock package registers alone regardless
// of load order.
const STOCK_PACKAGE_PATTERN = /(^|[/:])pi-ask-user(@[^/]*)?$/;

export function defaultSettingsPaths(): string[] {
	return [
		path.join(process.cwd(), ".pi", "settings.json"),
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
	];
}

export function findStockAskUserPackageEntry(settingsPaths: string[]): { entry: string; settingsPath: string } | null {
	for (const settingsPath of settingsPaths) {
		let packages: unknown;
		try {
			packages = JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.packages;
		} catch {
			continue;
		}
		if (!Array.isArray(packages)) continue;
		const entry = packages.find((pkg) => typeof pkg === "string" && STOCK_PACKAGE_PATTERN.test(pkg));
		if (entry) return { entry, settingsPath };
	}
	return null;
}

export function captureAskUserTool(stockFactory: (pi: ExtensionLike) => void, pi: ExtensionLike): ToolRegistration {
	let captured: ToolRegistration | null = null;
	const proxy = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolRegistration) => {
					if (tool?.name === "ask_user") {
						captured = tool;
						return;
					}
					return target.registerTool(tool);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as ExtensionLike;

	stockFactory(proxy);
	if (!captured) throw new Error("ask-user-remote: stock pi-ask-user did not register ask_user");
	return captured;
}

function warn(pi: ExtensionLike, options: InstallOptions, message: string): void {
	if (typeof options.warn === "function") {
		options.warn(message);
		return;
	}
	if (typeof pi.logger?.warn === "function") {
		pi.logger.warn(message);
		return;
	}
	if (typeof pi.log?.warn === "function") {
		pi.log.warn(message);
		return;
	}
	console.warn(message);
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): void {
	if (!parent) return;
	if (parent.aborted) {
		child.abort();
		return;
	}
	parent.addEventListener("abort", () => child.abort(), { once: true });
}

function stockResultFromRemote(params: any, response: any): any {
	const summary = response?.kind === "selection"
		? (Array.isArray(response.selections) ? response.selections.join(", ") : "")
		: response?.kind === "freeform"
			? String(response.text ?? "")
			: typeof response === "string"
				? response
				: JSON.stringify(response);
	return {
		content: [{ type: "text", text: `User answered: ${summary}` }],
		details: {
			question: params?.question,
			context: params?.context?.trim?.() || params?.context,
			options: normalizeOptions(params?.options ?? []),
			response,
			cancelled: false,
		},
	};
}

function normalizeOptions(options: any[]): Array<{ title: string; description?: string }> {
	return (Array.isArray(options) ? options : [])
		.map((option) => {
			if (typeof option === "string") return { title: option };
			if (option && typeof option === "object" && typeof option.title === "string") {
				return typeof option.description === "string"
					? { title: option.title, description: option.description }
					: { title: option.title };
			}
			return null;
		})
		.filter(Boolean) as Array<{ title: string; description?: string }>;
}

// Live remote questions started by defaultStartRemote, keyed by qid. A cancel
// must settle the pending result so the per-question endpoint server is closed;
// otherwise every locally-answered race leaks a bound socket until process exit.
const activeRemote = new Map<string, (error: Error) => void>();

export function activeRemoteCount(): number {
	return activeRemote.size;
}

async function defaultStartRemote(params: any): Promise<{ qid: string; result: Promise<any> } | null> {
	const coms = await import("../../../scripts/lib/coms-envelope.ts");
	const project = process.env.PI_COMS_PROJECT || "default";
	const peerName = process.env.PI_ASK_USER_REMOTE_PEER || "user-remote";
	const peer = coms.pruneDeadEntries(project).find((entry: any) => entry.name === peerName);
	if (!peer) return null;

	coms.ensureComsDirs(project);
	const id = {
		session_id: coms.ulid(),
		name: "ask-user-remote",
		endpoint: "",
		cwd: process.cwd(),
	};
	id.endpoint = coms.makeEndpoint(id.session_id);

	let resolveResult!: (value: any) => void;
	let rejectResult!: (error: Error) => void;
	const rawResult = new Promise<any>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const server = await coms.bindEndpoint(
		id.endpoint,
		coms.makeConnHandler((env: Record<string, unknown>, socket: any) => {
			if (coms.isResponseEnvelope(env)) {
				coms.writeAck(socket, env.msg_id);
				if (env.error) rejectResult(new Error(String(env.error)));
				else resolveResult(stockResultFromRemote(params, env.response));
				return;
			}
			coms.writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "ask-user-remote awaits responses only");
		}),
	);
	const cleanup = () => {
		try { server.close(); } catch { /* ignore */ }
		try { fs.unlinkSync(id.endpoint); } catch { /* ignore */ }
	};

	const promptPayload = JSON.stringify({
		question: params?.question,
		context: params?.context,
		options: params?.options ?? [],
	});
	const env = coms.makePromptEnvelope(id, promptPayload);
	activeRemote.set(env.msg_id, rejectResult);
	const result = rawResult.finally(() => {
		activeRemote.delete(env.msg_id);
		cleanup();
	});
	try {
		await coms.sendEnvelope(peer.endpoint, env);
	} catch (error) {
		rejectResult(error instanceof Error ? error : new Error(String(error)));
	}
	return { qid: env.msg_id, result };
}

async function defaultCancelRemote(qid: string, reason: string): Promise<void> {
	try {
		const coms = await import("../../../scripts/lib/coms-envelope.ts");
		const project = process.env.PI_COMS_PROJECT || "default";
		const peerName = process.env.PI_ASK_USER_REMOTE_PEER || "user-remote";
		const peer = coms.pruneDeadEntries(project).find((entry: any) => entry.name === peerName);
		if (peer) {
			await coms.sendEnvelope(peer.endpoint, coms.makeCancelEnvelope({
				from: "ask-user-remote",
				to: peer.name,
				ref_msg_id: qid,
			}));
		}
	} finally {
		// The bridge sends no response for a cancelled qid, so settle the pending
		// result here to release the per-question endpoint server.
		activeRemote.get(qid)?.(new Error(`ask-user-remote: cancelled (${reason})`));
	}
}

export function wrapAskUserTool(stockTool: ToolRegistration, options: InstallOptions = {}): ToolRegistration {
	return {
		...stockTool,
		async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
			const startRemote = options.startRemote ?? defaultStartRemote;
			let remoteStart: { qid: string; result: Promise<any> } | null = null;
			try {
				remoteStart = await startRemote(params, ctx);
			} catch {
				remoteStart = null;
			}

			if (!remoteStart) {
				return await stockTool.execute?.(toolCallId, params, signal, onUpdate, ctx);
			}

			return await raceAskUser({
				runLocal: (localSignal: AbortSignal) => stockTool.execute?.(toolCallId, params, localSignal, onUpdate, ctx),
				startRemote: () => remoteStart,
				cancelRemote: options.cancelRemote ?? defaultCancelRemote,
				createAbortController: () => {
					const controller = options.createAbortController?.() ?? new AbortController();
					linkAbortSignal(signal, controller);
					return controller;
				},
				signal,
			});
		},
	};
}

export function installAskUserRemote(pi: ExtensionLike, options: InstallOptions = {}): { registered: boolean; tool?: ToolRegistration } {
	if (options.settingsPaths) {
		const listed = findStockAskUserPackageEntry(options.settingsPaths);
		if (listed) {
			warn(pi, options, `ask-user-remote: "${listed.entry}" is listed in ${listed.settingsPath} "packages"; skipping the ask_user wrapper so the stock package registers without a tool conflict (remote answer racing disabled). Remove the entry — this harness loads pi-ask-user itself.`);
			return { registered: false };
		}
	}
	if (!options.stockFactory) throw new Error("ask-user-remote: stockFactory is required for synchronous install");
	const stockTool = captureAskUserTool(options.stockFactory, pi);
	const wrapped = wrapAskUserTool(stockTool, options);
	try {
		pi.registerTool(wrapped);
		return { registered: true, tool: wrapped };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(pi, options, `ask-user-remote: ask_user already registered; wrapper not installed (${message})`);
		return { registered: false };
	}
}

async function loadStockFactory(): Promise<(pi: ExtensionLike) => void> {
	const mod = await import("../../../node_modules/pi-ask-user/index.ts");
	return mod.default as (pi: ExtensionLike) => void;
}

export default function askUserRemote(pi: ExtensionLike): void {
	void loadStockFactory()
		.then((stockFactory) => installAskUserRemote(pi, { stockFactory, settingsPaths: defaultSettingsPaths() }))
		.catch((error) => warn(pi, {}, `ask-user-remote: failed to load pi-ask-user (${error instanceof Error ? error.message : String(error)})`));
}
