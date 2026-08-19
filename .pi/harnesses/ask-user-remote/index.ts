// ask-user-remote harness
//
// Captures the stock pi-ask-user `ask_user` tool, then registers a wrapper with
// the same schema/renderers/result shape. With no live `user-remote` coms peer
// it delegates to stock execute with the original arguments unchanged. When the
// peer is live, it races the stock local UI against a remote coms round trip.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	/** When true, settings-listed packages are dormant (Pi `--no-extensions`/`-ne`). */
	extensionDiscoveryDisabled?: boolean;
	remoteProject?: string | (() => string);
}

interface ResolveStockOptions {
	moduleUrl?: string;
	cwd?: string;
	homeDir?: string;
}

// A stock `pi-ask-user` package listed in pi settings is loaded by pi core
// itself only when extension discovery is enabled. Under `--no-extensions`/
// `-ne` the entry is dormant, so this harness must still install the wrapper.
// When discovery is enabled, registering here first would make pi core
// hard-crash later with a tool-name conflict — the preflight skips instead.
const STOCK_PACKAGE_PATTERN = /(^|[/:])pi-ask-user(@[^/]*)?$/;

export function defaultSettingsPaths(): string[] {
	return [
		path.join(process.cwd(), ".pi", "settings.json"),
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
	];
}

/** True when argv disables Pi package/extension discovery (explicit `-e` still works). */
export function hasDisabledExtensionDiscovery(argv: string[] = process.argv): boolean {
	return argv.includes("--no-extensions") || argv.includes("-ne");
}

interface StockPackageEntry {
	source: string;
	autoload?: boolean;
	extensions?: unknown;
}

function parseStockPackageEntry(value: unknown): StockPackageEntry | null {
	if (typeof value === "string") {
		return STOCK_PACKAGE_PATTERN.test(value) ? { source: value } : null;
	}
	if (!value || typeof value !== "object") return null;
	const entry = value as { source?: unknown; autoload?: unknown; extensions?: unknown };
	if (typeof entry.source !== "string" || !STOCK_PACKAGE_PATTERN.test(entry.source)) return null;
	return {
		source: entry.source,
		autoload: entry.autoload === false ? false : undefined,
		extensions: entry.extensions,
	};
}

function stockExtensionPatternMatches(rawPattern: string): boolean {
	let pattern = rawPattern;
	if (pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-")) pattern = pattern.slice(1);
	pattern = pattern.replace(/^\.\//, "");
	let expression = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				expression += ".*";
				i++;
			} else {
				expression += "[^/]*";
			}
		} else if (char === "?") {
			expression += "[^/]";
		} else {
			expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${expression}$`).test("index.ts");
}

function applyStockExtensionFilter(filter: unknown, inherited: boolean): boolean {
	if (filter === undefined || !Array.isArray(filter)) return inherited;
	if (filter.length === 0) return false;

	const patterns = filter.filter((value): value is string => typeof value === "string" && value.length > 0);
	const selectors = patterns.filter((pattern) => !pattern.startsWith("!") && !pattern.startsWith("+") && !pattern.startsWith("-"));
	let enabled = selectors.length > 0
		? selectors.some(stockExtensionPatternMatches)
		: inherited;

	for (const pattern of patterns) {
		if (!stockExtensionPatternMatches(pattern)) continue;
		if (pattern.startsWith("!") || pattern.startsWith("-")) enabled = false;
		else if (pattern.startsWith("+")) enabled = true;
	}
	return enabled;
}

export function findStockAskUserPackageEntry(settingsPaths: string[]): { entry: string; settingsPath: string } | null {
	const located: Array<{ entry: StockPackageEntry; settingsPath: string }> = [];
	for (const settingsPath of settingsPaths) {
		let packages: unknown;
		try {
			packages = JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.packages;
		} catch {
			continue;
		}
		if (!Array.isArray(packages)) continue;
		const entry = packages.map(parseStockPackageEntry).find(Boolean);
		if (entry) located.push({ entry, settingsPath });
	}

	// Pi resolves lower-precedence settings first. A normal project entry
	// replaces the global entry; `autoload:false` applies only its resource
	// filter as a delta over the inherited package state.
	let enabled = false;
	let owner: { entry: StockPackageEntry; settingsPath: string } | null = null;
	for (let i = located.length - 1; i >= 0; i--) {
		const current = located[i];
		const inherited = current.entry.autoload === false ? enabled : true;
		enabled = applyStockExtensionFilter(current.entry.extensions, inherited);
		owner = enabled ? current : null;
	}
	return owner ? { entry: owner.entry.source, settingsPath: owner.settingsPath } : null;
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

export function resolveRemoteProject(pi: ExtensionLike, argv: string[] = process.argv): string {
	for (let i = argv.length - 2; i >= 0; i--) {
		if (argv[i] === "--project" && typeof argv[i + 1] === "string" && argv[i + 1].trim()) {
			return argv[i + 1].trim();
		}
	}
	const inlineProject = [...argv].reverse().find((arg) => arg.startsWith("--project="))?.slice("--project=".length).trim();
	if (inlineProject) return inlineProject;
	const cliProject = typeof pi.getFlag === "function" ? pi.getFlag("project") : undefined;
	if (typeof cliProject === "string" && cliProject.trim()) return cliProject.trim();
	const envProject = process.env.PI_COMS_PROJECT;
	return envProject?.trim() || "default";
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

async function defaultStartRemote(params: any, project: string): Promise<{ qid: string; result: Promise<any> } | null> {
	const coms = await import("../../../scripts/lib/coms-envelope.ts");
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

async function defaultCancelRemote(qid: string, reason: string, project: string): Promise<void> {
	try {
		const coms = await import("../../../scripts/lib/coms-envelope.ts");
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

// Keep UI preferences in the stock implementation; expose only question semantics.
export const COMPACT_ASK_USER_PARAMETERS = {
	type: "object",
	properties: {
		question: { type: "string", description: "One focused question." },
		context: { type: "string", description: "Short decision context." },
		options: { type: "array", items: { type: "string", description: "Choice label." }, minItems: 2, maxItems: 6, description: "Two to six choices." },
		allowMultiple: { type: "boolean", description: "Allow several choices." },
		allowFreeform: { type: "boolean", description: "Allow a typed answer." },
		allowComment: { type: "boolean", description: "Allow an optional comment." },
	},
	required: ["question"],
} as const;

export function compactAskUserParams(params: any): any {
	return {
		question: params?.question,
		...(params?.context === undefined ? {} : { context: params.context }),
		...(params?.options === undefined ? {} : { options: normalizeOptions(params.options) }),
		...(params?.allowMultiple === undefined ? {} : { allowMultiple: params.allowMultiple }),
		...(params?.allowFreeform === undefined ? {} : { allowFreeform: params.allowFreeform }),
		...(params?.allowComment === undefined ? {} : { allowComment: params.allowComment }),
	};
}

export function wrapAskUserTool(stockTool: ToolRegistration, options: InstallOptions = {}): ToolRegistration {
	return {
		...stockTool,
		description: "Ask one focused human question; choices are optional.",
		promptSnippet: "Ask one focused human question",
		promptGuidelines: ["Ask one focused question per call."],
		parameters: COMPACT_ASK_USER_PARAMETERS,
		async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
			const stockParams = compactAskUserParams(params);
			const configuredProject = typeof options.remoteProject === "function" ? options.remoteProject() : options.remoteProject;
			const remoteProject = configuredProject ?? process.env.PI_COMS_PROJECT?.trim() ?? "default";
			const startRemote = options.startRemote ?? ((remoteParams: any) => defaultStartRemote(remoteParams, remoteProject));
			let remoteStart: { qid: string; result: Promise<any> } | null = null;
			try {
				remoteStart = await startRemote(stockParams, ctx);
			} catch {
				remoteStart = null;
			}

			if (!remoteStart) {
				return await stockTool.execute?.(toolCallId, stockParams, signal, onUpdate, ctx);
			}

			return await raceAskUser({
				runLocal: (localSignal: AbortSignal) => stockTool.execute?.(toolCallId, stockParams, localSignal, onUpdate, ctx),
				startRemote: () => remoteStart,
				cancelRemote: options.cancelRemote ?? ((qid: string, reason: string) => defaultCancelRemote(qid, reason, remoteProject)),
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
	const discoveryDisabled = options.extensionDiscoveryDisabled === true;
	// Settings presence is not runtime availability: under --no-extensions the
	// package entry is dormant and the wrapper must still install itself.
	if (!discoveryDisabled && options.settingsPaths) {
		const listed = findStockAskUserPackageEntry(options.settingsPaths);
		if (listed) {
			warn(pi, options, `ask-user-remote: "${listed.entry}" is listed in ${listed.settingsPath} "packages" and extension discovery is enabled; skipping the ask_user wrapper so the stock package registers without a tool conflict (remote answer racing disabled for this session).`);
			return { registered: false };
		}
	}
	if (!options.stockFactory) throw new Error("ask-user-remote: stockFactory is required for synchronous install");
	const stockTool = captureAskUserTool(options.stockFactory, pi);
	const wrapped = wrapAskUserTool(stockTool, {
		...options,
		remoteProject: options.remoteProject ?? (() => resolveRemoteProject(pi)),
	});
	try {
		pi.registerTool(wrapped);
		return { registered: true, tool: wrapped };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(pi, options, `ask-user-remote: ask_user already registered; wrapper not installed (${message})`);
		return { registered: false };
	}
}

const STOCK_ENTRY_NAMES = ["index.ts", "index.js", "index.mjs"] as const;

function stockEntriesUnder(packageDir: string): string[] {
	return STOCK_ENTRY_NAMES.map((name) => path.join(packageDir, name));
}

/**
 * Candidate filesystem paths for stock `pi-ask-user`, in priority order:
 * 1. Package-native bundled dependency beside the Agent Fleet package
 * 2. Project Pi package (`.pi/npm`)
 * 3. Harness runtime dependency (`.pi/harnesses/node_modules`)
 * 4. Global Pi package (`~/.pi/agent/npm`)
 *
 * Each root expands to `index.ts`, then `index.js` / `index.mjs` so plain-Node
 * smoke fixtures can supply a JS stub while production still prefers the
 * upstream TypeScript entry that Pi's jiti loader understands.
 */
export function stockAskUserCandidatePaths(options: ResolveStockOptions = {}): string[] {
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();

	// Pi's jiti loader preserves the workspace-facing path of a symlinked
	// harness. Canonicalize this module first so the bundled dependency is
	// resolved beside the actual Agent Fleet package, not at workspace root.
	const realModulePath = fs.realpathSync(fileURLToPath(moduleUrl));
	const moduleDir = path.dirname(realModulePath);
	// ask-user-remote lives at <package>/.pi/harnesses/ask-user-remote
	const packageRoot = path.resolve(moduleDir, "../../..");
	const harnessRoot = path.resolve(moduleDir, "..");

	let isPackageNative = false;
	try {
		isPackageNative = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))?.name === "@chankov/agent-fleet";
	} catch {
		// A copied harness has no Agent Fleet package root; do not treat the
		// downstream application's node_modules as a bundled runtime source.
	}

	const roots = [
		...(isPackageNative ? [path.join(packageRoot, "node_modules", "pi-ask-user")] : []),
		path.join(cwd, ".pi", "npm", "node_modules", "pi-ask-user"),
		path.join(harnessRoot, "node_modules", "pi-ask-user"),
		path.join(cwd, ".pi", "harnesses", "node_modules", "pi-ask-user"),
		path.join(homeDir, ".pi", "agent", "npm", "node_modules", "pi-ask-user"),
	];
	return roots.flatMap((root) => stockEntriesUnder(root));
}

export const MISSING_STOCK_ASK_USER_MESSAGE =
	"ask-user-remote: pi-ask-user not found. Run `npm ci --prefix .pi/harnesses` and/or `pi install -l npm:pi-ask-user`.";

export function resolveStockAskUserModule(options: ResolveStockOptions | string = {}): string {
	// Back-compat: older callers passed moduleUrl as the first positional arg.
	const normalized: ResolveStockOptions = typeof options === "string" ? { moduleUrl: options } : options;
	const seen = new Set<string>();
	for (const candidate of stockAskUserCandidatePaths(normalized)) {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		if (fs.existsSync(resolved)) {
			return pathToFileURL(fs.realpathSync(resolved)).href;
		}
	}
	throw new Error(MISSING_STOCK_ASK_USER_MESSAGE);
}

async function loadStockFactory(): Promise<(pi: ExtensionLike) => void> {
	const mod = await import(resolveStockAskUserModule());
	return mod.default as (pi: ExtensionLike) => void;
}

export default async function askUserRemote(pi: ExtensionLike): Promise<void> {
	// Await registration so session_start probes (e.g. agent-hub getAllTools)
	// see ask_user after extension factories finish loading.
	try {
		const stockFactory = await loadStockFactory();
		installAskUserRemote(pi, {
			stockFactory,
			settingsPaths: defaultSettingsPaths(),
			extensionDiscoveryDisabled: hasDisabledExtensionDiscovery(),
		});
	} catch (error) {
		warn(pi, {}, `ask-user-remote: failed to load pi-ask-user (${error instanceof Error ? error.message : String(error)})`);
	}
}
