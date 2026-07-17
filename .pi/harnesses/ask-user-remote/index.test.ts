import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	activeRemoteCount,
	captureAskUserTool,
	defaultSettingsPaths,
	findStockAskUserPackageEntry,
	installAskUserRemote,
	wrapAskUserTool,
} from "./index.ts";

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
	const comsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-remote-leak-"));
	process.env.PI_COMS_DIR = comsDir;
	t.after(() => fs.rmSync(comsDir, { recursive: true, force: true }));

	const coms = await import("../../../scripts/lib/coms-envelope.ts");
	coms.ensureComsDirs("default");
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
	}, "default");

	const expected = stockResult("local-wins");
	const wrapped = wrapAskUserTool(stockTool({ execute: async () => expected }));
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
	assert.match(warnings[0], /Remove the entry/);

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
