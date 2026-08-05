import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
	activeRemoteCount,
	captureAskUserTool,
	defaultSettingsPaths,
	findStockAskUserPackageEntry,
	hasDisabledExtensionDiscovery,
	installAskUserRemote,
	MISSING_STOCK_ASK_USER_MESSAGE,
	resolveRemoteProject,
	resolveStockAskUserModule,
	stockAskUserCandidatePaths,
	wrapAskUserTool,
} from "./index.ts";
import { socketTempRoot } from "../../../scripts/lib/monitor-env.ts";

function stockResult(label: string) {
	return {
		content: [{ type: "text", text: `User answered: ${label}` }],
		details: {
			question: "Question?",
			options: [],
			response: { kind: "freeform", text: label },
			cancelled: false,
		},
	};
}

function stockTool(overrides: Record<string, unknown> = {}) {
	return {
		name: "ask_user",
		label: "Ask User",
		parameters: { type: "object" },
		execute: async () => stockResult("stock"),
		renderCall: () => "call-renderer",
		renderResult: () => "result-renderer",
		...overrides,
	};
}

test("captures stock ask_user registration with name, execute, and renderers intact", () => {
	const execute = async () => stockResult("captured");
	const renderCall = () => "render-call";
	const renderResult = () => "render-result";
	const tool = stockTool({ execute, renderCall, renderResult });
	const pi = {
		registerTool: () => assert.fail("capture proxy must not register ask_user on the host pi"),
		events: { emit() {} },
	};

	const captured = captureAskUserTool((proxy) => proxy.registerTool(tool), pi as any);
	assert.equal(captured.name, "ask_user");
	assert.equal(captured.execute, execute);
	assert.equal(captured.renderCall, renderCall);
	assert.equal(captured.renderResult, renderResult);
});

test("with no remote peer, wrapper calls stock execute with original args and returns the same result", async () => {
	const expected = stockResult("local-only");
	const params = { question: "Question?", context: "Context", options: ["A"] };
	const signal = new AbortController().signal;
	const onUpdate = () => {};
	const ctx = { hasUI: true };
	let seenArgs: unknown[] = [];
	const tool = stockTool({
		execute: async (...args: unknown[]) => {
			seenArgs = args;
			return expected;
		},
	});
	const wrapped = wrapAskUserTool(tool, { startRemote: () => null });

	const actual = await wrapped.execute("tool-call-1", params, signal, onUpdate, ctx);
	assert.equal(actual, expected);
	assert.deepEqual(seenArgs, ["tool-call-1", params, signal, onUpdate, ctx]);
	assert.equal(wrapped.renderCall, tool.renderCall);
	assert.equal(wrapped.renderResult, tool.renderResult);
	assert.equal(wrapped.parameters, tool.parameters);
});

test("abort signal reaches the captured stock execute and resolves cancelled:true in fallback mode", async () => {
	const controller = new AbortController();
	const tool = stockTool({
		execute: async (_id: string, params: any, signal: AbortSignal) => {
			if (signal.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { question: params.question, response: null, cancelled: true } };
			}
			return await new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve({
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question: params.question, response: null, cancelled: true },
				}), { once: true });
			});
		},
	});
	const wrapped = wrapAskUserTool(tool, { startRemote: () => null });
	const pending = wrapped.execute("tool-call-1", { question: "Cancel?" }, controller.signal, undefined, { hasUI: true });
	controller.abort();
	const result = await pending;
	assert.equal(result.details.cancelled, true);
});

test("real stock pi-ask-user source maps overlay abort to cancelled:true", () => {
	const source = readFileSync(new URL("../../../node_modules/pi-ask-user/index.ts", import.meta.url), "utf8");

	assert.match(source, /const\s+customFactory\s*=\s*\([^)]*done:\s*\([^)]*\)\s*=>\s*void[^)]*\)\s*=>\s*{/);
	assert.match(source, /signal\.addEventListener\("abort",\s*onAbort,\s*\{\s*once:\s*true\s*\}\)/);
	assert.match(source, /const\s+onAbort\s*=\s*\(\)\s*=>\s*done\(null\)/);
	assert.match(source, /if\s*\(result\s*===\s*null\)\s*{[\s\S]*?content:\s*\[\{\s*type:\s*"text",\s*text:\s*"User cancelled the question"\s*\}\][\s\S]*?details:\s*\{[\s\S]*?response:\s*null,\s*cancelled:\s*true[\s\S]*?}/);
});

test("duplicate ask_user registration logs a readable warning and does not crash", () => {
	const warnings: string[] = [];
	const pi = {
		registerTool(tool: any) {
			assert.equal(tool.name, "ask_user");
			throw new Error("Tool ask_user is already registered");
		},
	};

	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		warn: (message) => warnings.push(message),
	});

	assert.deepEqual(result, { registered: false });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ask-user-remote: ask_user already registered; wrapper not installed/);
	assert.match(warnings[0], /Tool ask_user is already registered/);
});

test("remote project follows pi --project before environment fallback", () => {
	const previous = process.env.PI_COMS_PROJECT;
	process.env.PI_COMS_PROJECT = "environment-project";
	try {
		assert.equal(resolveRemoteProject({ getFlag: (name: string) => name === "project" ? "af" : undefined } as any), "af");
		assert.equal(resolveRemoteProject({ getFlag: () => "default" } as any, ["pi", "--project", "af"]), "af");
		assert.equal(resolveRemoteProject({ getFlag: () => undefined } as any), "environment-project");
		delete process.env.PI_COMS_PROJECT;
		assert.equal(resolveRemoteProject({ getFlag: () => undefined } as any), "default");
	} finally {
		if (previous === undefined) delete process.env.PI_COMS_PROJECT;
		else process.env.PI_COMS_PROJECT = previous;
	}
});

test("successful install registers exactly one wrapped ask_user tool", async () => {
	const registered: any[] = [];
	const pi = { registerTool: (tool: any) => registered.push(tool) };
	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		startRemote: () => null,
	});

	assert.equal(result.registered, true);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "ask_user");
	assert.notEqual(registered[0], stockTool);
	assert.deepEqual(await registered[0].execute("id", { question: "Q" }, undefined, undefined, {}), stockResult("stock"));
});

test("agent-hub-style getAllTools probe sees ask_user after wrapper registration", () => {
	const registered: any[] = [];
	const pi = {
		registerTool: (tool: any) => registered.push(tool),
		getAllTools: () => registered,
	};
	installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		startRemote: () => null,
	});

	const askUserAvailable = pi.getAllTools().some((tool) => tool.name === "ask_user");
	const dispatcherTools = ["dispatch_agent", "spawn_research", "set_assertions", "update_assertion", "get_assertions"];
	if (askUserAvailable) dispatcherTools.push("ask_user");
	assert.equal(askUserAvailable, true);
	assert.ok(dispatcherTools.includes("ask_user"));
});

test("a locally-won race settles and closes the per-question remote endpoint (no server leak)", async (t) => {
	// defaultStartRemote/defaultCancelRemote import coms-envelope lazily, so the
	// COMS_DIR override must be in place before the first execute() below.
	// socketTempRoot, not os.tmpdir: this directory holds a bound per-question
	// coms endpoint, and macOS truncates a socket path that long.
	const comsDir = fs.mkdtempSync(path.join(socketTempRoot(), "ask-user-remote-leak-"));
	process.env.PI_COMS_DIR = comsDir;
	t.after(() => fs.rmSync(comsDir, { recursive: true, force: true }));

	const coms = await import("../../../scripts/lib/coms-envelope.ts");
	coms.ensureComsDirs("af");
	const peerSession = coms.ulid();
	const peerEndpoint = coms.makeEndpoint(peerSession);
	const seen: string[] = [];
	const peerServer = await coms.bindEndpoint(
		peerEndpoint,
		coms.makeConnHandler((env, socket) => {
			seen.push(String((env as { type?: string }).type));
			coms.writeAck(socket, (env as { msg_id?: string }).msg_id ?? "");
		}),
	);
	t.after(() => { try { peerServer.close(); } catch { /* ignore */ } });
	coms.writeRegistryAtomic({
		session_id: peerSession,
		name: "user-remote",
		purpose: "test peer",
		model: "test",
		color: "#000000",
		pid: process.pid,
		endpoint: peerEndpoint,
		cwd: process.cwd(),
		started_at: coms.nowIso(),
		explicit: false,
		version: 1,
	}, "af");

	const expected = stockResult("local-wins");
	let runtimeProject = "default";
	const wrapped = wrapAskUserTool(stockTool({ execute: async () => expected }), { remoteProject: () => runtimeProject });
	runtimeProject = "af";
	const result = await wrapped.execute("tool-call-leak", { question: "Q?" }, undefined, undefined, {});
	assert.equal(result, expected);

	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(seen, ["prompt", "cancel"]);
	assert.equal(activeRemoteCount(), 0);
	const sockets = fs.readdirSync(path.join(comsDir, "sockets"));
	assert.deepEqual(sockets, [path.basename(peerEndpoint)], "per-question endpoint must be unlinked after cancel");
});

// Mimics pi core's tool registry: a duplicate name is a hard crash, not a
// catchable failure for the extension that registered first.
function piCoreLikeRegistry() {
	const tools = new Map<string, any>();
	return {
		tools,
		registerTool(tool: any) {
			if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" conflicts`);
			tools.set(tool.name, tool);
		},
	};
}

function writeSettings(t: any, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-remote-settings-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const settingsPath = path.join(dir, "settings.json");
	fs.writeFileSync(settingsPath, contents);
	return settingsPath;
}

test("preflight finds a stock pi-ask-user package entry across settings paths", (t) => {
	const missing = path.join(os.tmpdir(), "ask-user-remote-no-such-dir", "settings.json");
	const malformed = writeSettings(t, "{ not json");
	const clean = writeSettings(t, JSON.stringify({ packages: ["npm:pi-codex-image-gen", "npm:pi-ask-user-extras"] }));
	const listed = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));

	assert.deepEqual(
		findStockAskUserPackageEntry([missing, malformed, clean, listed]),
		{ entry: "npm:pi-ask-user", settingsPath: listed },
	);
	assert.equal(findStockAskUserPackageEntry([missing, malformed, clean]), null);

	const pinned = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user@1.2.0"] }));
	assert.equal(findStockAskUserPackageEntry([pinned])?.entry, "npm:pi-ask-user@1.2.0");
});

test("preflight honors active and disabled object-form package entries", (t) => {
	const active = writeSettings(t, JSON.stringify({
		packages: [{ source: "npm:pi-ask-user" }],
	}));
	const disabled = writeSettings(t, JSON.stringify({
		packages: [{ source: "npm:pi-ask-user", extensions: [] }],
	}));

	assert.deepEqual(
		findStockAskUserPackageEntry([active]),
		{ entry: "npm:pi-ask-user", settingsPath: active },
	);
	assert.equal(findStockAskUserPackageEntry([disabled]), null);
});

test("preflight applies project autoload:false extension deltas over the global package entry", (t) => {
	const globalEnabled = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));
	const projectDisables = writeSettings(t, JSON.stringify({
		packages: [{ source: "npm:pi-ask-user", autoload: false, extensions: ["-index.ts"] }],
	}));
	assert.equal(findStockAskUserPackageEntry([projectDisables, globalEnabled]), null);

	const globalDisabled = writeSettings(t, JSON.stringify({
		packages: [{ source: "npm:pi-ask-user", extensions: [] }],
	}));
	const projectEnables = writeSettings(t, JSON.stringify({
		packages: [{ source: "npm:pi-ask-user", autoload: false, extensions: ["+index.ts"] }],
	}));
	assert.deepEqual(
		findStockAskUserPackageEntry([projectEnables, globalDisabled]),
		{ entry: "npm:pi-ask-user", settingsPath: projectEnables },
	);
});

test("harness-first order: settings preflight skips the wrapper so a later stock package load cannot conflict", (t) => {
	const settingsPath = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));
	const pi = piCoreLikeRegistry();
	const warnings: string[] = [];

	// Harness loads first. Without the preflight it would register ask_user here,
	// and pi core would hard-crash below when loading the settings-listed package.
	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		settingsPaths: [settingsPath],
		warn: (message) => warnings.push(message),
	});
	assert.deepEqual(result, { registered: false });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /"npm:pi-ask-user" is listed in .* "packages"/);
	assert.match(warnings[0], /extension discovery is enabled/);
	assert.match(warnings[0], /remote answer racing disabled/);

	// pi core now loads the stock package — must register cleanly, no crash.
	pi.registerTool(stockTool());
	assert.equal(pi.tools.get("ask_user").label, "Ask User");
});

test("clean settings preflight still installs the wrapper", (t) => {
	const settingsPath = writeSettings(t, JSON.stringify({ packages: ["npm:pi-codex-image-gen"] }));
	const pi = piCoreLikeRegistry();
	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		settingsPaths: [settingsPath],
		startRemote: () => null,
	});
	assert.equal(result.registered, true);
	assert.equal(pi.tools.get("ask_user"), result.tool);
});

test("default settings paths cover the project and global pi settings files", () => {
	assert.deepEqual(defaultSettingsPaths(), [
		path.join(process.cwd(), ".pi", "settings.json"),
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
	]);
});

test("repo .pi/settings.json no longer lists the stock pi-ask-user package", () => {
	const settingsPath = new URL("../../settings.json", import.meta.url);
	assert.equal(findStockAskUserPackageEntry([settingsPath.pathname]), null);
});

test("package manifest defaults to ask-user-remote instead of direct stock pi-ask-user", () => {
	const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"));
	assert.deepEqual(pkg.pi.extensions, ["./.pi/harnesses/ask-user-remote/index.ts"]);
	assert.ok(pkg.dependencies["pi-ask-user"]);
});

test("detects both Pi flags that disable extension discovery", () => {
	assert.equal(hasDisabledExtensionDiscovery(["pi", "--no-extensions"]), true);
	assert.equal(hasDisabledExtensionDiscovery(["pi", "-ne"]), true);
	assert.equal(hasDisabledExtensionDiscovery(["pi"]), false);
	assert.equal(hasDisabledExtensionDiscovery(["pi", "--tools", "read"]), false);
});

test("settings entry + discovery enabled: wrapper defers so stock can register once", (t) => {
	const settingsPath = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));
	const pi = piCoreLikeRegistry();
	const warnings: string[] = [];

	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		settingsPaths: [settingsPath],
		extensionDiscoveryDisabled: false,
		warn: (message) => warnings.push(message),
	});

	assert.deepEqual(result, { registered: false });
	assert.equal(pi.tools.size, 0);
	assert.equal(warnings.length, 1);

	// Stock package registers alone — no conflict.
	pi.registerTool(stockTool({ label: "Stock Ask User" }));
	assert.equal(pi.tools.size, 1);
	assert.equal(pi.tools.get("ask_user").label, "Stock Ask User");
});

test("settings entry + --no-extensions: wrapper registers exactly one wrapped ask_user", (t) => {
	const settingsPath = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));
	const pi = piCoreLikeRegistry();
	const warnings: string[] = [];

	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		settingsPaths: [settingsPath],
		extensionDiscoveryDisabled: true,
		startRemote: () => null,
		warn: (message) => warnings.push(message),
	});

	assert.equal(result.registered, true);
	assert.equal(pi.tools.size, 1);
	assert.equal(pi.tools.get("ask_user"), result.tool);
	assert.deepEqual(warnings, []);
});

test("settings entry + -ne flag detection installs the wrapper when discovery is disabled", (t) => {
	const settingsPath = writeSettings(t, JSON.stringify({ packages: ["npm:pi-ask-user"] }));
	assert.equal(hasDisabledExtensionDiscovery(["pi", "-ne"]), true);

	const pi = piCoreLikeRegistry();
	const result = installAskUserRemote(pi as any, {
		stockFactory: (proxy) => proxy.registerTool(stockTool()),
		settingsPaths: [settingsPath],
		extensionDiscoveryDisabled: hasDisabledExtensionDiscovery(["pi", "-ne"]),
		startRemote: () => null,
	});
	assert.equal(result.registered, true);
});

test("resolver prefers package-native, then .pi/npm, harness runtime, then global", (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-resolve-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const packageRoot = path.join(root, "agent-fleet-pkg");
	const harnessDir = path.join(packageRoot, ".pi", "harnesses", "ask-user-remote");
	fs.mkdirSync(harnessDir, { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@chankov/agent-fleet" }));
	const modulePath = path.join(harnessDir, "index.ts");
	fs.writeFileSync(modulePath, "// fixture module\n");

	const cwd = path.join(root, "workspace");
	const homeDir = path.join(root, "home");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(homeDir, { recursive: true });

	const locations = {
		packageNative: path.join(packageRoot, "node_modules", "pi-ask-user", "index.ts"),
		projectPi: path.join(cwd, ".pi", "npm", "node_modules", "pi-ask-user", "index.ts"),
		harnessRuntime: path.join(packageRoot, ".pi", "harnesses", "node_modules", "pi-ask-user", "index.ts"),
		globalPi: path.join(homeDir, ".pi", "agent", "npm", "node_modules", "pi-ask-user", "index.ts"),
	};

	const writeStock = (filePath: string, marker: string) => {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `// ${marker}\n`);
	};

	const fileUrl = (filePath: string) => pathToFileURL(fs.realpathSync(filePath)).href;
	const moduleUrl = pathToFileURL(modulePath).href;
	const resolve = () => resolveStockAskUserModule({ moduleUrl, cwd, homeDir });

	// Priority 4: global only
	writeStock(locations.globalPi, "global");
	assert.equal(resolve(), fileUrl(locations.globalPi));

	// Priority 3: harness runtime beats global
	writeStock(locations.harnessRuntime, "harness");
	assert.equal(resolve(), fileUrl(locations.harnessRuntime));

	// Priority 2: project Pi package beats harness
	writeStock(locations.projectPi, "project");
	assert.equal(resolve(), fileUrl(locations.projectPi));

	// Priority 1: package-native bundled beats all
	writeStock(locations.packageNative, "bundled");
	assert.equal(resolve(), fileUrl(locations.packageNative));

	const candidates = stockAskUserCandidatePaths({ moduleUrl, cwd, homeDir });
	assert.equal(candidates[0], locations.packageNative);
	assert.ok(candidates.includes(locations.projectPi));
	assert.ok(candidates.includes(locations.harnessRuntime));
	assert.ok(candidates.includes(locations.globalPi));
});

test("copied harness ignores workspace-root node_modules and selects its pinned runtime dependency", (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-copied-resolve-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const workspace = path.join(root, "downstream-app");
	const harnessDir = path.join(workspace, ".pi", "harnesses", "ask-user-remote");
	fs.mkdirSync(harnessDir, { recursive: true });
	fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "downstream-app" }));
	const modulePath = path.join(harnessDir, "index.ts");
	fs.writeFileSync(modulePath, "// copied harness fixture\n");

	const unrelatedRootDependency = path.join(workspace, "node_modules", "pi-ask-user", "index.ts");
	const harnessDependency = path.join(workspace, ".pi", "harnesses", "node_modules", "pi-ask-user", "index.ts");
	for (const [filePath, marker] of [[unrelatedRootDependency, "unrelated"], [harnessDependency, "pinned"]] as const) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `// ${marker}\n`);
	}

	const options = {
		moduleUrl: pathToFileURL(modulePath).href,
		cwd: workspace,
		homeDir: path.join(root, "home"),
	};
	assert.equal(resolveStockAskUserModule(options), pathToFileURL(fs.realpathSync(harnessDependency)).href);
	assert.ok(!stockAskUserCandidatePaths(options).includes(unrelatedRootDependency));
});

test("missing stock dependency throws one actionable message", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-missing-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const harnessDir = path.join(root, "pkg", ".pi", "harnesses", "ask-user-remote");
	fs.mkdirSync(harnessDir, { recursive: true });
	const modulePath = path.join(harnessDir, "index.ts");
	fs.writeFileSync(modulePath, "// empty\n");

	assert.throws(
		() => resolveStockAskUserModule({
			moduleUrl: pathToFileURL(modulePath).href,
			cwd: path.join(root, "cwd"),
			homeDir: path.join(root, "home"),
		}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, MISSING_STOCK_ASK_USER_MESSAGE);
			assert.match(error.message, /npm ci --prefix \.pi\/harnesses/);
			assert.match(error.message, /pi install -l npm:pi-ask-user/);
			return true;
		},
	);
});

test("subprocess smoke: default export registers ask_user into configured and active tool lists", (t) => {
	// Plain Node cannot type-strip TS under node_modules (Pi uses jiti). Stage a
	// JS stock stub ahead of the real package-native candidate so the child can
	// exercise the async default export end-to-end without an LLM call.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-smoke-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const packageRoot = path.join(root, "pkg");
	const harnessDir = path.join(packageRoot, ".pi", "harnesses", "ask-user-remote");
	fs.mkdirSync(harnessDir, { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@chankov/agent-fleet" }));

	// Copy the harness sources the default export needs.
	for (const name of ["index.ts", "race-core.js"]) {
		fs.copyFileSync(new URL(`./${name}`, import.meta.url), path.join(harnessDir, name));
	}

	const stockJs = path.join(packageRoot, "node_modules", "pi-ask-user", "index.js");
	fs.mkdirSync(path.dirname(stockJs), { recursive: true });
	fs.writeFileSync(stockJs, `
export default function stockAskUser(pi) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { cancelled: false } }),
  });
}
`);

	const harnessUrl = pathToFileURL(path.join(harnessDir, "index.ts")).href;
	const script = `
import harness from ${JSON.stringify(harnessUrl)};

const configured = new Map();
const active = new Set();
const pi = {
  registerTool(tool) {
    if (configured.has(tool.name)) throw new Error('Tool "' + tool.name + '" conflicts');
    configured.set(tool.name, tool);
    active.add(tool.name);
  },
  getAllTools() { return [...configured.values()]; },
  getActiveTools() { return [...active]; },
};

await harness(pi);
const configuredNames = pi.getAllTools().map((tool) => tool.name);
const activeNames = pi.getActiveTools();
if (!configuredNames.includes("ask_user") || !activeNames.includes("ask_user")) {
  console.error(JSON.stringify({ ok: false, configuredNames, activeNames }));
  process.exit(2);
}
console.log(JSON.stringify({ ok: true, configuredNames, activeNames }));
`;

	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		cwd: root,
		env: process.env,
		timeout: 30_000,
	});
	assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
	const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.equal(payload.ok, true);
	assert.ok(payload.configuredNames.includes("ask_user"));
	assert.ok(payload.activeNames.includes("ask_user"));
});
