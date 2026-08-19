import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function startRpcProbe(probePath: string) {
	const env = { ...process.env, PI_OFFLINE: "1" };
	delete env.HERDR_ENV;
	delete env.HERDR_PANE_ID;
	delete env.HERDR_WORKSPACE_ID;
	const child = spawn(piExecutable, [
		"--mode", "rpc", "--no-session", "--no-extensions",
		...extensionPaths.flatMap(extensionPath => ["-e", extensionPath]),
		"-e", probePath, "--solo", "--posture", "operator", "--agent-team", "default",
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

	async function close(): Promise<void> {
		child.stdin.end();
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3_000);
			child.once("exit", () => { clearTimeout(timer); resolve(); });
		});
	}

	return { request, activeTools, notificationAfter, close };
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
			for (const tool of ["dispatch_agent", "spawn_research", "set_assertions"]) assert.ok(active.includes(tool));
			if (posture === "operator") {
				for (const tool of ["read", "bash", "edit", "write"]) assert.ok(active.includes(tool), `${tool} should be active`);
			} else {
				for (const tool of ["read", "bash", "edit", "write"]) assert.ok(!active.includes(tool), `${tool} should be inactive`);
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
		for (const name of ["af-posture", "af-handoff", "af-agents-add", "probe-active-tools"]) {
			assert.ok(initialNames.includes(name), `${name} should remain registered`);
		}

		const operator = await rpc.activeTools();
		for (const tool of ["read", "bash", "edit", "write", "dispatch_agent", "ask_user"]) {
			assert.ok(operator.includes(tool), `${tool} should be active for operator`);
		}
		for (const gated of ["coms_send", "herdr_spawn_peer", "herdr_spawn_pane"]) {
			assert.ok(!operator.includes(gated), `${gated} should stay gated when unavailable`);
		}

		assert.equal((await rpc.request({ type: "prompt", message: "/af-posture orchestrator" })).success, true);
		const orchestrator = await rpc.activeTools();
		for (const tool of ["read", "bash", "edit", "write"]) {
			assert.ok(!orchestrator.includes(tool), `${tool} should be inactive for orchestrator`);
		}
		for (const tool of ["dispatch_agent", "spawn_research", "set_assertions", "ask_user"]) {
			assert.ok(orchestrator.includes(tool), `${tool} should remain active for orchestrator`);
		}

		const switchedCommands = await rpc.request({ type: "get_commands" });
		const switchedNames = switchedCommands.data.commands.map((command: { name: string }) => command.name);
		for (const name of ["af-posture", "af-handoff", "af-agents-add"]) {
			assert.ok(switchedNames.includes(name), `${name} should survive posture switching`);
		}

		assert.equal((await rpc.request({ type: "prompt", message: "/af-posture operator" })).success, true);
		assert.deepEqual((await rpc.activeTools()).sort(), operator.sort(), "operator tool surface should restore in the same process");
	} finally {
		await rpc.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("mode and task reset commands append attributable runtime audit entries", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-hub-audit-rpc-"));
	const probePath = join(workspace, "probe-audit.ts");
	writeFileSync(probePath, `
export default function (pi) {
  pi.registerCommand("probe-audit", {
    description: "Test-only audit entry probe",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries()
        .filter(entry => entry.type === "custom" && ["agent-hub-mode", "agent-hub-task-reset"].includes(entry.customType));
      ctx.ui.notify("AUDIT_ENTRIES:" + JSON.stringify(entries), "info");
    },
  });
}
`);
	const rpc = startRpcProbe(probePath);
	try {
		assert.equal((await rpc.request({ type: "prompt", message: "/af-hub-mode fast" })).success, true);
		assert.equal((await rpc.request({ type: "prompt", message: "/af-new-task audit-check" })).success, true);
		const entries = JSON.parse(await rpc.notificationAfter("/probe-audit", "AUDIT_ENTRIES:"));
		const modeEntries = entries.filter((entry: any) => entry.customType === "agent-hub-mode").map((entry: any) => entry.data);
		const resetEntries = entries.filter((entry: any) => entry.customType === "agent-hub-task-reset").map((entry: any) => entry.data);
		assert.ok(modeEntries.some((entry: any) => entry.source === "default"), "session_start default application must be audited");
		assert.ok(modeEntries.some((entry: any) => entry.source === "slash-command" && entry.previous_mode === "standard" && entry.mode === "fast"));
		assert.ok(resetEntries.some((entry: any) => entry.source === "slash-command" && entry.label === "audit-check"));
		for (const entry of [...modeEntries, ...resetEntries]) {
			assert.equal(entry.identity.cwd, resolve(repoRoot));
			assert.ok(entry.identity.pid > 0);
			assert.equal(entry.identity.herdr_pane_id, null);
		}
	} finally {
		await rpc.close();
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
