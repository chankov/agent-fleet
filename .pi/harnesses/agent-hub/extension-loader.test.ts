import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const piExecutable = join(repoRoot, "node_modules", ".bin", "pi");

const extensionPaths = [
	".pi/harnesses/damage-control-continue/index.ts",
	".pi/harnesses/ask-user-remote/index.ts",
	".pi/harnesses/agent-hub/index.ts",
];

function runExtensionStack(cwd: string, extraArgs: string[] = []) {
	return spawnSync(
		piExecutable,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			...extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]),
			...extraArgs,
		],
		{
			cwd,
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1" },
		},
	);
}

function assertExtensionStackLoaded(result: ReturnType<typeof spawnSync>) {
	if (result.error) {
		assert.fail(`Failed to spawn repo-local Pi executable "${piExecutable}": ${result.error.message ?? String(result.error)}`);
	}

	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, `Pi failed to start (exit ${result.status}):\n${output}`);
	assert.doesNotMatch(output, /Failed to load extension "[^"]+":/);
	assert.doesNotMatch(output, /failed to load pi-ask-user/);
	assert.doesNotMatch(output, /Unknown option: --solo/);
}

function startRpcProbe(
	probePath: string,
	extraArgs: string[] = [],
	options: { beforeHubExtensions?: string[]; fleetArgs?: string[] } = {},
) {
	const env = { ...process.env, PI_OFFLINE: "1" };
	delete env.HERDR_ENV;
	delete env.HERDR_PANE_ID;
	delete env.HERDR_WORKSPACE_ID;
	const stack = [extensionPaths[0], extensionPaths[1], ...(options.beforeHubExtensions ?? []), extensionPaths[2]];
	const fleetArgs = options.fleetArgs ?? ["--solo", "--posture", "operator", "--agent-team", "default"];
	const child = spawn(piExecutable, [
		"--mode", "rpc", "--no-session", "--no-extensions",
		...stack.flatMap(extensionPath => ["-e", extensionPath]),
		"-e", probePath, ...extraArgs, ...fleetArgs,
	], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
	let sequence = 0;
	let stdoutBuffer = "";
	let stderr = "";
	const pending = new Map<string, (event: any) => void>();
	const notifications: string[] = [];

	child.stderr.on("data", chunk => { stderr += String(chunk); });
	child.stdout.on("data", chunk => {
		stdoutBuffer += String(chunk);
		for (;;) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			const event = JSON.parse(line);
			if (event.type === "response" && event.id && pending.has(event.id)) {
				const resolve = pending.get(event.id)!;
				pending.delete(event.id);
				resolve(event);
			}
			if (event.type === "extension_ui_request" && event.method === "notify") {
				notifications.push(String(event.message ?? ""));
			}
		}
	});

	function request(command: Record<string, unknown>): Promise<any> {
		const id = `posture-rpc-${++sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC timeout for ${JSON.stringify(command)}\n${stderr}`));
			}, 20_000);
			pending.set(id, event => {
				clearTimeout(timer);
				resolve(event);
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	async function notificationAfter(message: string, prefix: string): Promise<string> {
		const start = notifications.length;
		const response = await request({ type: "prompt", message });
		assert.equal(response.success, true, JSON.stringify(response));
		const report = notifications.slice(start).find(value => value.startsWith(prefix));
		assert.ok(report, `probe notification missing; notifications=${JSON.stringify(notifications.slice(start))}`);
		return report.slice(prefix.length);
	}

	async function activeTools(): Promise<string[]> {
		return JSON.parse(await notificationAfter("/probe-active-tools", "ACTIVE_TOOLS:"));
	}

	async function waitForNotification(prefix: string, timeoutMs = 20_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const report = notifications.find(value => value.startsWith(prefix));
			if (report) return report.slice(prefix.length);
			if (Date.now() >= deadline) throw new Error(`Notification timeout for ${prefix}; notifications=${JSON.stringify(notifications)}\n${stderr}`);
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}

	async function close(): Promise<void> {
		child.stdin.end();
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3_000);
			child.once("exit", () => { clearTimeout(timer); resolve(); });
		});
	}

	return { request, activeTools, notificationAfter, waitForNotification, close };
}

test("Pi loads the guarded agent-hub extension stack through jiti", () => {
	assertExtensionStackLoaded(runExtensionStack(repoRoot));
});

test("Hub fleet, verification, coms, and Herdr schemas stay compact without changing their fields", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-schema-runtime-"));
	try {
		const capturePath = join(workspace, "tools.json");
		const probePath = join(workspace, "probe.ts");
		writeFileSync(probePath, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    const tools = pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    writeFileSync(process.env.TOOL_CAPTURE, JSON.stringify(tools));
  });
}
`);
		const result = spawnSync(piExecutable, ["--mode", "rpc", "--no-session", "--no-extensions", ...extensionPaths.flatMap(extensionPath => ["-e", extensionPath]), "-e", probePath, "--solo", "--posture", "operator"], {
			cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", TOOL_CAPTURE: capturePath },
		});
		assertExtensionStackLoaded(result);
		const tools = JSON.parse(readFileSync(capturePath, "utf8"));
		const names = ["dispatch_agent", "spawn_research", "set_assertions", "update_assertion", "get_assertions", "coms_list", "coms_send", "coms_get", "coms_await", "herdr_spawn_peer", "herdr_spawn_pane", "herdr_read_pane", "herdr_close_pane", "herdr_notify"];
		const selected = tools.filter((tool: any) => names.includes(tool.name));
		assert.equal(selected.length, names.length);
		assert.ok(JSON.stringify(selected).length < 8_000, `compact serialized schemas=${JSON.stringify(selected).length}`);
		for (const [name, fields] of [["dispatch_agent", ["agent", "task", "artifacts", "scope", "watchdog", "review_reason", "backend"]], ["set_assertions", ["assertions"]], ["coms_send", ["target", "prompt", "handoff_token", "conversation_id", "response_schema", "reply_timeout_ms"]], ["herdr_spawn_peer", ["name", "runner", "persona", "no_persona", "model", "extensions", "browser", "all_extensions", "direction"]]] as const) {
			const tool = selected.find((entry: any) => entry.name === name);
			assert.deepEqual(Object.keys(tool.parameters.properties), fields, `${name} accepted fields`);
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("effective Hub profiles stay within deterministic prompt plus active-schema budgets", async () => {
	const cases = [
		{ name: "greeting", message: "hello", maxChars: 14_000, expectedTool: "ask_user" },
		{ name: "direct", message: "Fix the parser and run its tests.", maxChars: 18_000, expectedTool: "read" },
		{ name: "fleet", message: "Delegate this implementation to a specialist.", maxChars: 20_000, expectedTool: "dispatch_agent" },
		{ name: "verification", message: "Implement this feature with acceptance criteria.", maxChars: 20_000, expectedTool: "set_assertions" },
		{ name: "compaction", message: "Please compact the conversation.", maxChars: 20_000, expectedTool: "request_compaction", extraArgs: ["-e", ".pi/extensions/compact-and-continue/index.ts"] },
	] as const;
	for (const profile of cases) {
		const workspace = mkdtempSync(join(tmpdir(), `agent-hub-budget-${profile.name}-`));
		const probePath = join(workspace, "probe-budget.ts");
		const capturePath = join(workspace, "profile-budget.json");
		writeFileSync(probePath, `
+import { writeFileSync } from "node:fs";
+import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
+
+const capturePath = ${JSON.stringify(capturePath)};
+
+function streamBudgetProbe(model, context) {
+  const stream = createAssistantMessageEventStream();
+  queueMicrotask(() => {
+    const schemas = context.tools ?? [];
+    writeFileSync(capturePath, JSON.stringify({
+      promptChars: String(context.systemPrompt ?? "").length,
+      schemaChars: JSON.stringify(schemas).length,
+      active: schemas.map(tool => tool.name),
+    }));
+    const output = {
+      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
+      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
+        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
+      stopReason: "stop", timestamp: Date.now(),
+    };
+    stream.push({ type: "start", partial: output });
+    output.content.push({ type: "text", text: "ok" });
+    stream.push({ type: "text_start", contentIndex: 0, partial: output });
+    stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
+    stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
+    stream.push({ type: "done", reason: "stop", message: output });
+    stream.end();
+  });
+  return stream;
+}
+
+export default function (pi) {
+  pi.registerProvider("profile-budget-test", {
+    name: "Profile Budget Test", baseUrl: "http://127.0.0.1", apiKey: "test", api: "profile-budget-test-api",
+    models: [{ id: "model", name: "Model", reasoning: false, input: ["text"],
+      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000 }],
+    streamSimple: streamBudgetProbe,
+  });
+}
+`.replace(/^\+/gm, ""));
		const extraArgs = [
			...("extraArgs" in profile ? [...profile.extraArgs] : []),
			"--model", "profile-budget-test/model",
		];
		const rpc = startRpcProbe(probePath, extraArgs);
		try {
			const promptResponse = await rpc.request({ type: "prompt", message: profile.message });
			assert.equal(promptResponse.success, true, `${profile.name}: ${JSON.stringify(promptResponse)}`);
			const captureDeadline = Date.now() + 10_000;
			while (!existsSync(capturePath)) {
				if (Date.now() >= captureDeadline) assert.fail(`${profile.name} provider context was not captured`);
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			const measured = JSON.parse(readFileSync(capturePath, "utf8"));
			assert.ok(measured.promptChars > 0, `${profile.name} must expose its effective replacement prompt`);
			assert.ok(measured.promptChars + measured.schemaChars <= profile.maxChars,
				`${profile.name} effective chars=${measured.promptChars + measured.schemaChars} > ${profile.maxChars}`);
			assert.ok(measured.active.includes(profile.expectedTool), `${profile.name} must expose ${profile.expectedTool}`);
			if (profile.name !== "fleet") assert.ok(!measured.active.includes("dispatch_agent"));
		} finally {
			await rpc.close();
			rmSync(workspace, { recursive: true, force: true });
		}
	}
});

test("tool-result pressure aborts before a tool loop can make another provider request", async () => {
	const workspace = mkdtempSync(join(repoRoot, ".tmp-context-pressure-e2e-"));
	const probePath = join(workspace, "pressure-provider.ts");
	const eventPath = join(workspace, "events.ndjson");
	writeFileSync(probePath, String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

let providerCalls = 0;
const eventPath = process.env.PRESSURE_EVENT_PATH;
const record = (value) => appendFileSync(eventPath, JSON.stringify(value) + "\n");

function streamPressure(model, context, options) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      const aborted = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "aborted", timestamp: Date.now(), errorMessage: "pressure recovery abort" };
      record({ type: "provider_aborted" });
      stream.push({ type: "start", partial: aborted });
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end();
      return;
    }
    providerCalls++;
    const output = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: providerCalls === 1 ? 190000 : providerCalls === 2 ? 220000 : 1000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    output.usage.totalTokens = output.usage.input + output.usage.output;
    record({ type: "provider", call: providerCalls, summaryPrompt: /context summarization assistant/i.test(context.systemPrompt || ""), toolCount: context.tools?.length ?? 0, deferred: JSON.stringify(context.messages).includes("deferred-after-pressure") });
    stream.push({ type: "start", partial: output });
    if (providerCalls === 2) {
      const toolCall = { type: "toolCall", id: "pressure-call", name: "pressure_probe", arguments: {} };
      output.content.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
      output.stopReason = "toolUse";
    } else {
      const text = providerCalls === 1 ? "seed ".repeat(20000) : "context recovery summary";
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
    }
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  });
  return stream;
}

export default function (pi) {
  pi.registerProvider("pressure-test", {
    name: "Pressure Test", baseUrl: "http://127.0.0.1", apiKey: "test", api: "pressure-test-api",
    models: [{ id: "pressure-model", name: "Pressure Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000 }],
    streamSimple: streamPressure,
  });
  pi.registerTool({ name: "pressure_probe", label: "Pressure Probe", description: "Return a large synthetic tool result.",
    parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "x".repeat(140000) }] }; } });
  pi.on("turn_end", (_event, ctx) => record({ type: "turn_end", active: pi.getActiveTools(), entries: ctx.sessionManager.getEntries().map(entry => entry.type) }));
}
`);
	const previousPath = process.env.PRESSURE_EVENT_PATH;
	process.env.PRESSURE_EVENT_PATH = eventPath;
	const rpc = startRpcProbe(probePath, ["-e", ".pi/extensions/compact-and-continue/index.ts", "--model", "pressure-test/pressure-model"]);
	try {
		assert.equal((await rpc.request({ type: "prompt", message: "seed the previous turn" })).success, true);
		const firstTurnDeadline = Date.now() + 10_000;
		while (!existsSync(eventPath) || !readFileSync(eventPath, "utf8").includes('"type":"turn_end"')) {
			if (Date.now() >= firstTurnDeadline) assert.fail("seed turn did not settle");
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.equal((await rpc.request({ type: "prompt", message: "run the pressure probe" })).success, true);
		await rpc.waitForNotification("Context reached 90%; pausing the tool loop for automatic compaction.", 10_000);
		assert.equal((await rpc.request({ type: "prompt", message: "deferred-after-pressure" })).success, true,
			"input arriving during recovery is handled rather than rejected as streaming");
		try {
			await rpc.waitForNotification("Automatic context compaction completed.", 30_000);
		} catch (error) {
			assert.fail(`${error instanceof Error ? error.message : String(error)}\nevents=${existsSync(eventPath) ? readFileSync(eventPath, "utf8") : "missing"}`);
		}
		const replayDeadline = Date.now() + 10_000;
		while (!readFileSync(eventPath, "utf8").includes('"deferred":true')) {
			if (Date.now() >= replayDeadline) assert.fail(`deferred input was not replayed after compaction: ${readFileSync(eventPath, "utf8")}`);
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		const events = readFileSync(eventPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const providers = events.filter(event => event.type === "provider");
		const deferredIndex = providers.findIndex(event => event.deferred);
		assert.ok(deferredIndex >= 3, `expected seed + tool + compaction before replay: ${JSON.stringify(providers)}`);
		assert.ok(providers[0].toolCount > 0 && providers[1].toolCount > 0, "the first two calls are ordinary agent turns");
		assert.ok(providers.slice(2, deferredIndex).every(event => event.summaryPrompt && event.toolCount === 0),
			`no ordinary provider request may run between pressure and recovery: ${JSON.stringify(providers)}`);
		assert.equal(providers[deferredIndex].summaryPrompt, false);
		assert.ok(providers[deferredIndex].toolCount > 0, "deferred input replays through the ordinary Hub surface");
		assert.ok(events.filter(event => event.type === "provider_aborted").length <= 1,
			"the tool-loop continuation is either preempted before provider invocation or aborted exactly once");
		const pressureTurns = events.filter(event => event.type === "turn_end");
		assert.ok(pressureTurns.some(event => event.active.includes("request_compaction")),
			"the transient compaction tool is visible during the pressure episode");
	} finally {
		await rpc.close();
		if (previousPath === undefined) delete process.env.PRESSURE_EVENT_PATH;
		else process.env.PRESSURE_EVENT_PATH = previousPath;
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("legacy orchestrator state without a roster loads fail-closed and blocks provider input", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-roster-recovery-"));
	try {
		const seedPath = join(workspace, "seed-legacy-posture.ts");
		const capturePath = join(workspace, "capture-gate.ts");
		const statePath = join(workspace, "state.json");
		const providerPath = join(workspace, "provider-called");
		writeFileSync(seedPath, `
export default function (pi) {
  pi.on("session_start", () => {
    pi.appendEntry("agent-hub-posture", { posture: "orchestrator" });
  });
}
`);
		writeFileSync(capturePath, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("roster-gate-test", {
    name: "Roster Gate Test", baseUrl: "http://127.0.0.1", apiKey: "test", api: "roster-gate-test-api",
    models: [{ id: "model", name: "Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 }],
    streamSimple() { writeFileSync(process.env.PROVIDER_CALLED, "yes"); throw new Error("roster gate allowed a provider request"); },
  });
  pi.on("session_start", (event, ctx) => writeFileSync(process.env.ROSTER_CAPTURE, JSON.stringify({
    tools: pi.getActiveTools(),
    entries: ctx.sessionManager.getEntries().filter(entry => entry.type === "custom").map(entry => ({ customType: entry.customType, data: entry.data })),
  })));
}
`);
		const result = spawnSync(piExecutable, [
			"--mode", "print", "--no-session", "--no-extensions",
			"-e", extensionPaths[0], "-e", extensionPaths[1], "-e", seedPath,
			"-e", extensionPaths[2], "-e", capturePath,
			"--solo", "--model", "roster-gate-test/model", "attempt model input",
		], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1", ROSTER_CAPTURE: statePath, PROVIDER_CALLED: providerPath },
		});
		assertExtensionStackLoaded(result);
		assert.match(`${result.stdout}\n${result.stderr}`, /Persisted orchestrator posture has no native roster/);
		assert.equal(existsSync(providerPath), false, "fail-closed input must not reach the provider");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		for (const direct of ["read", "bash", "edit", "write"]) assert.ok(!state.tools.includes(direct), `${direct} must remain unavailable`);
		assert.ok(state.entries.some((entry: any) => entry.customType === "agent-hub-posture" && entry.data.posture === "orchestrator"));
		assert.ok(!state.entries.some((entry: any) => entry.customType === "agent-hub-native-roster"), "legacy state remains metadata-only and does not invent a roster");

	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("legacy no-roster recovery blocks slash commands that could start model work", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-roster-command-gate-"));
	const seedPath = join(workspace, "seed-legacy-posture.ts");
	const probePath = join(workspace, "roster-command-provider.ts");
	const providerPath = join(workspace, "provider-called");
	writeFileSync(seedPath, `
export default function (pi) {
  pi.on("session_start", () => pi.appendEntry("agent-hub-posture", { posture: "orchestrator" }));
}
`);
	writeFileSync(probePath, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("roster-command-gate", {
    name: "Roster Command Gate", baseUrl: "http://127.0.0.1", apiKey: "test", api: "roster-command-gate-api",
    models: [{ id: "model", name: "Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 }],
    streamSimple() { writeFileSync(${JSON.stringify(providerPath)}, "yes"); throw new Error("roster command gate allowed a provider request"); },
  });
}
`);
	const rpc = startRpcProbe(probePath, ["--model", "roster-command-gate/model"], {
		beforeHubExtensions: [seedPath],
		fleetArgs: ["--solo"],
	});
	try {
		for (const command of [
			"/af-research inspect the workspace",
			"/af-agents-cont r1 continue",
			"/af-agents-restart builder",
			"/af-handoff reviewer",
			"/af-compound",
		]) {
			await rpc.notificationAfter(command, "Persisted orchestrator posture has no native roster.");
		}
		assert.equal(existsSync(providerPath), false, "no guarded command may reach the parent provider");
	} finally {
		await rpc.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("runtime posture activates operator tools and restricts orchestrator tools", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-posture-runtime-"));
	try {
		const capturePath = join(workspace, "active-tools.json");
		const probePath = join(workspace, "probe.ts");
		writeFileSync(probePath, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => writeFileSync(process.env.POSTURE_CAPTURE, JSON.stringify(pi.getActiveTools())));
}
`);
		for (const posture of ["operator", "orchestrator"]) {
			const result = spawnSync(
				piExecutable,
				[
					"--mode", "rpc", "--no-session", "--no-extensions",
					...extensionPaths.flatMap(extensionPath => ["-e", extensionPath]),
					"-e", probePath, "--solo", "--posture", posture,
					...(posture === "orchestrator" ? ["--agent-team", "default"] : []),
				],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: { ...process.env, PI_OFFLINE: "1", POSTURE_CAPTURE: capturePath },
				},
			);
			assertExtensionStackLoaded(result);
			if (posture === "operator") assert.match(result.stdout, /Native roster: \(none\) \(0\)/);
			else assert.match(result.stdout, /Native roster: default \([1-9][0-9]*\)/);
			const active = JSON.parse(readFileSync(capturePath, "utf8"));
			if (posture === "operator") {
				for (const tool of ["read", "bash", "edit", "write"]) assert.ok(active.includes(tool), `${tool} should be active`);
				for (const tool of ["dispatch_agent", "spawn_research", "set_assertions"]) assert.ok(!active.includes(tool), `${tool} should be inactive on greeting`);
			} else {
				for (const tool of ["read", "bash", "edit", "write", "set_assertions"]) assert.ok(!active.includes(tool), `${tool} should be inactive`);
				for (const tool of ["dispatch_agent", "spawn_research", "set_task_tier", "team_adjust"]) assert.ok(active.includes(tool), `${tool} should be active for orchestrator`);
			}
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("live posture switching changes tools without restarting and keeps Hub commands", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-live-posture-rpc-"));
	const probePath = join(workspace, "probe-active-tools.ts");
	writeFileSync(probePath, `
export default function (pi) {
  pi.registerCommand("probe-active-tools", {
    description: "Test-only active tool probe",
    handler: async (_args, ctx) => ctx.ui.notify("ACTIVE_TOOLS:" + JSON.stringify(pi.getActiveTools()), "info"),
  });
}
`);
	const rpc = startRpcProbe(probePath);
	try {
		const initialCommands = await rpc.request({ type: "get_commands" });
		assert.equal(initialCommands.success, true, JSON.stringify(initialCommands));
		const initialNames = initialCommands.data.commands.map((command: { name: string }) => command.name);
		for (const name of ["af-posture", "af-work-mode", "af-handoff", "af-agents-add", "probe-active-tools"]) {
			assert.ok(initialNames.includes(name), `${name} should remain registered`);
		}

		const operator = await rpc.activeTools();
		for (const tool of ["read", "bash", "edit", "write", "ask_user"]) assert.ok(operator.includes(tool), `${tool} should be active for operator`);
		for (const tool of ["dispatch_agent", "spawn_research", "set_assertions"]) assert.ok(!operator.includes(tool), `${tool} should be inactive for operator greeting`);
		for (const gated of ["coms_send", "herdr_spawn_peer", "herdr_spawn_pane"]) {
			assert.ok(!operator.includes(gated), `${gated} should stay gated when unavailable`);
		}

		// Even offline Pi invokes input before it rejects the provider request; this
		// proves the same normal prompt updates its tool surface without a classifier.
		await rpc.request({ type: "prompt", message: "Delegate this to a specialist." });
		const delegated = await rpc.activeTools();
		for (const tool of ["dispatch_agent", "spawn_research", "set_task_tier", "team_adjust"]) assert.ok(delegated.includes(tool), `${tool} should activate from the incoming prompt`);

		assert.equal((await rpc.request({ type: "prompt", message: "/af-posture orchestrator" })).success, true);
		const orchestrator = await rpc.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(!orchestrator.includes(tool), `${tool} should be inactive for orchestrator`);
		}
		for (const tool of ["dispatch_agent", "spawn_research", "set_task_tier", "team_adjust", "ask_user"]) assert.ok(orchestrator.includes(tool), `${tool} should remain active for orchestrator`);
		for (const tool of ["set_assertions"]) assert.ok(!orchestrator.includes(tool), `${tool} should remain inactive without verification intent`);

		const switchedCommands = await rpc.request({ type: "get_commands" });
		const switchedNames = switchedCommands.data.commands.map((command: { name: string }) => command.name);
		for (const name of ["af-posture", "af-work-mode", "af-handoff", "af-agents-add"]) {
			assert.ok(switchedNames.includes(name), `${name} should survive posture switching`);
		}

		assert.equal((await rpc.request({ type: "prompt", message: "/af-posture operator" })).success, true);
		const restored = await rpc.activeTools();
		for (const tool of ["read", "bash", "edit", "write", "dispatch_agent", "spawn_research"]) assert.ok(restored.includes(tool), `${tool} should remain available while the task fleet pack is retained`);
	} finally {
		await rpc.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("mode command remains auditable and af-new-task is no longer registered", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-audit-rpc-"));
	const probePath = join(workspace, "probe-audit.ts");
	writeFileSync(probePath, `
export default function (pi) {
  pi.registerCommand("probe-audit", {
    description: "Test-only audit entry probe",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries()
        .filter(entry => entry.type === "custom" && entry.customType === "agent-hub-mode");
      ctx.ui.notify("AUDIT_ENTRIES:" + JSON.stringify(entries), "info");
    },
  });
}
`);
	const rpc = startRpcProbe(probePath);
	try {
		const commands = await rpc.request({ type: "get_commands" });
		assert.ok(!commands.data.commands.some((command: { name: string }) => command.name === "af-new-task"));
		assert.equal((await rpc.request({ type: "prompt", message: "/af-hub-mode fast" })).success, true);
		const entries = JSON.parse(await rpc.notificationAfter("/probe-audit", "AUDIT_ENTRIES:"));
		const modeEntries = entries.filter((entry: any) => entry.customType === "agent-hub-mode").map((entry: any) => entry.data);
		assert.ok(modeEntries.some((entry: any) => entry.source === "default"), "session_start default application must be audited");
		assert.ok(modeEntries.some((entry: any) => entry.source === "slash-command" && entry.previous_mode === "standard" && entry.mode === "fast"));
		for (const entry of modeEntries) {
			assert.equal(entry.identity.cwd, resolve(repoRoot));
			assert.ok(entry.identity.pid > 0);
			assert.equal(entry.identity.herdr_pane_id, null);
		}
	} finally {
		await rpc.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("work-mode command applies recommended profiles and refuses orchestrator without a roster", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-work-mode-rpc-"));
	const probePath = join(workspace, "probe-work-mode.ts");
	writeFileSync(probePath, `
export default function (pi) {
  pi.registerCommand("probe-active-tools", {
    description: "Test-only active tool probe",
    handler: async (_args, ctx) => ctx.ui.notify("ACTIVE_TOOLS:" + JSON.stringify(pi.getActiveTools()), "info"),
  });
  pi.registerCommand("probe-work-mode", {
    description: "Test-only mode/posture probe",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries()
        .filter(entry => entry.type === "custom" && (entry.customType === "agent-hub-mode" || entry.customType === "agent-hub-posture"));
      ctx.ui.notify("WORK_MODE_ENTRIES:" + JSON.stringify(entries), "info");
    },
  });
}
`);
	const withRoster = startRpcProbe(probePath);
	try {
		const commands = await withRoster.request({ type: "get_commands" });
		assert.ok(commands.data.commands.some((command: { name: string }) => command.name === "af-work-mode"));
		assert.equal((await withRoster.request({ type: "prompt", message: "/af-work-mode fast" })).success, true);
		const operator = await withRoster.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(operator.includes(tool), `${tool} should remain active for Fast Operator`);
		}
		const afterFast = JSON.parse(await withRoster.notificationAfter("/probe-work-mode", "WORK_MODE_ENTRIES:"));
		assert.ok(afterFast.some((entry: any) => entry.customType === "agent-hub-mode" && entry.data?.source === "slash-command" && entry.data?.previous_mode === "standard" && entry.data?.mode === "fast"));
		assert.ok(!afterFast.some((entry: any) => entry.customType === "agent-hub-posture" && entry.data?.posture === "orchestrator"));

		assert.equal((await withRoster.request({ type: "prompt", message: "/af-work-mode standard" })).success, true);
		const orchestrator = await withRoster.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(!orchestrator.includes(tool), `${tool} should be inactive for Standard Orchestrator`);
		}
		for (const tool of ["dispatch_agent", "spawn_research"]) {
			assert.ok(orchestrator.includes(tool), `${tool} should remain active for Standard Orchestrator`);
		}
		const afterStandard = JSON.parse(await withRoster.notificationAfter("/probe-work-mode", "WORK_MODE_ENTRIES:"));
		assert.ok(afterStandard.some((entry: any) => entry.customType === "agent-hub-posture" && entry.data?.posture === "orchestrator"));
		assert.ok(afterStandard.some((entry: any) => entry.customType === "agent-hub-mode" && entry.data?.source === "slash-command" && entry.data?.mode === "standard"));

		assert.equal((await withRoster.request({ type: "prompt", message: "/af-work-mode fast orchestrator" })).success, true);
		const custom = await withRoster.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(!custom.includes(tool), `${tool} should stay inactive for Fast Orchestrator`);
		}
		const afterCustom = JSON.parse(await withRoster.notificationAfter("/probe-work-mode", "WORK_MODE_ENTRIES:"));
		const latestMode = [...afterCustom].reverse().find((entry: any) => entry.customType === "agent-hub-mode")?.data;
		const latestPosture = [...afterCustom].reverse().find((entry: any) => entry.customType === "agent-hub-posture")?.data;
		assert.equal(latestMode?.mode, "fast");
		assert.equal(latestPosture?.posture, "orchestrator");
	} finally {
		await withRoster.close();
	}

	const noRoster = startRpcProbe(probePath, [], { fleetArgs: ["--solo", "--posture", "operator"] });
	try {
		assert.equal((await noRoster.request({ type: "prompt", message: "/af-work-mode standard" })).success, true);
		const stillOperator = await noRoster.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(stillOperator.includes(tool), `${tool} should remain after refused orchestrator profile`);
		}
		const refused = JSON.parse(await noRoster.notificationAfter("/probe-work-mode", "WORK_MODE_ENTRIES:"));
		assert.ok(!refused.some((entry: any) => entry.customType === "agent-hub-mode" && entry.data?.source === "slash-command"));
		assert.ok(!refused.some((entry: any) => entry.customType === "agent-hub-posture" && entry.data?.posture === "orchestrator"));

		assert.equal((await noRoster.request({ type: "prompt", message: "/af-work-mode fast" })).success, true);
		const afterFast = JSON.parse(await noRoster.notificationAfter("/probe-work-mode", "WORK_MODE_ENTRIES:"));
		assert.ok(afterFast.some((entry: any) => entry.customType === "agent-hub-mode" && entry.data?.source === "slash-command" && entry.data?.mode === "fast"));
		const tools = await noRoster.activeTools();
		for (const tool of ["read", "bash"]) assert.ok(tools.includes(tool), `${tool} should remain active for Fast Operator`);
	} finally {
		await noRoster.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Pi loads a symlinked hub after a package-only update", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-symlink-loader-"));
	try {
		for (const harness of ["damage-control-continue", "ask-user-remote", "agent-hub", "lib"]) {
			const target = join(workspace, ".pi", "harnesses", harness);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(join(repoRoot, ".pi", "harnesses", harness), target, "dir");
		}
		// A package-only install hoists agent-fleet's production dependencies into
		// the consuming workspace's node_modules; it does not install the nested
		// .pi/harnesses/package.json. Mirror that layout so this regression test
		// cannot pass only because a developer ran `just fleet install` locally.
		symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");

		const manifest = JSON.parse(readFileSync(join(repoRoot, "bin", "catalog", "harness-runtime-closure.json"), "utf8"));
		for (const relativePath of manifest.files.filter((value: string) => value.startsWith("scripts/"))) {
			const target = join(workspace, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(repoRoot, relativePath), target);
		}

		assertExtensionStackLoaded(runExtensionStack(workspace, ["--solo"]));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
