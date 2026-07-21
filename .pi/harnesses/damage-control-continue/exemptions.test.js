// Behavioral tests for the damage-control exemption layer: the harness is
// loaded against a fake ExtensionAPI, with "@mariozechner/pi-coding-agent"
// (provided by pi at runtime) stubbed via a module resolve hook.

// Must be set before shared.ts is imported — ESCALATION_TIMEOUT_MS is read at module load.
process.env.AGENT_HUB_ASK_TIMEOUT_MS = "300";

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@mariozechner/pi-coding-agent") {
			return {
				url: "data:text/javascript,export const isToolCallEventType = (toolName, event) => event.toolName === toolName;",
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

const continueExt = (await import("./index.ts")).default;
const { readExemptionsFile } = await import("../lib/damage-control-shared.ts");

const RULES_YAML = `
bashToolPatterns:
  - pattern: '\\brm\\s+-[rRf]'
    reason: rm with recursive or force flags
zeroAccessPaths:
  - ".env"
readOnlyPaths:
  - "package-lock.json"
noDeletePaths:
  - "README.md"
`;

function fixtureCwd() {
	const cwd = mkdtempSync(join(tmpdir(), "dc-exemptions-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "damage-control-rules.yaml"), RULES_YAML);
	return cwd;
}

function fakePi() {
	const handlers = {};
	const commands = {};
	const log = [];
	return {
		pi: {
			on: (event, handler) => { (handlers[event] ||= []).push(handler); },
			registerCommand: (name, def) => { commands[name] = def; },
			appendEntry: (type, data) => { log.push({ type, data }); },
			getFlag: () => undefined,
		},
		handlers, commands, log,
	};
}

function fakeCtx(cwd, { hasUI = false, select } = {}) {
	const state = { aborted: false, selectCalls: 0, selectOptions: [], notifications: [], statuses: new Map() };
	const ctx = {
		cwd,
		hasUI,
		abort: () => { state.aborted = true; },
		ui: {
			notify: (msg) => state.notifications.push(msg),
			setStatus: (key, text) => state.statuses.set(key, text),
			select: async (...args) => {
				state.selectCalls++;
				state.selectOptions.push(args[1]);
				return select ? select(...args) : undefined;
			},
			confirm: async () => false,
		},
	};
	return { ctx, state };
}

// Boots a harness instance: session_start loads the fixture rules, then
// returns dispatchers for tool_call / agent_end / commands.
async function boot(ext, cwd, ctxOpts) {
	const { pi, handlers, commands, log } = fakePi();
	ext(pi);
	const { ctx, state } = fakeCtx(cwd, ctxOpts);
	for (const h of handlers.session_start || []) await h({ type: "session_start" }, ctx);
	return {
		ctx, state, commands, log,
		toolCall: (event) => handlers.tool_call[0](event, ctx),
		agentEnd: async () => { for (const h of handlers.agent_end || []) await h({ type: "agent_end" }, ctx); },
	};
}

const readEnv = { type: "tool_call", toolName: "read", input: { path: ".env" } };
const deleteReadme = { type: "tool_call", toolName: "bash", input: { command: "rm -- README.md" } };

test.beforeEach(() => {
	delete process.env.AGENT_HUB_ASK_ENDPOINT;
	delete process.env.AGENT_HUB_EXEMPTIONS_FILE;
	delete process.env.AGENT_HUB_AGENT_ID;
});

test("continue: blocks a zero-access read by default (headless, no hub)", async () => {
	const h = await boot(continueExt, fixtureCwd());
	const res = await h.toolCall(readEnv);
	assert.equal(res.block, true);
	assert.match(res.reason, /zero-access/);
});

test("continue: /allow <pattern> turn exempts until agent_end", async () => {
	const h = await boot(continueExt, fixtureCwd());
	await h.commands.allow.handler(".env turn", h.ctx);
	assert.equal((await h.toolCall(readEnv)).block, false);
	await h.agentEnd();
	assert.equal((await h.toolCall(readEnv)).block, true);
});

test("continue: /allow session persists across turns and mirrors to the shared file", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "dc-exemptions-")), "exemptions.json");
	process.env.AGENT_HUB_EXEMPTIONS_FILE = file;
	const cwd = fixtureCwd();
	const h = await boot(continueExt, cwd);
	await h.commands.allow.handler(".env", h.ctx); // default scope: session
	assert.equal((await h.toolCall(readEnv)).block, false);
	await h.agentEnd();
	assert.equal((await h.toolCall(readEnv)).block, false);

	// a fresh instance (≈ spawned child) picks the grant up from the file
	const child = await boot(continueExt, cwd);
	assert.equal((await child.toolCall(readEnv)).block, false);

	// /revoke removes it everywhere
	await h.commands.revoke.handler(".env", h.ctx);
	assert.equal((await h.toolCall(readEnv)).block, true);
	const child2 = await boot(continueExt, cwd);
	assert.equal((await child2.toolCall(readEnv)).block, true);
});

test("continue: interactive block-time prompt grants for the session", async () => {
	const h = await boot(continueExt, fixtureCwd(), {
		hasUI: true,
		select: (_title, options) => options.find((o) => o.includes("session")),
	});
	assert.equal((await h.toolCall(readEnv)).block, false);
	assert.equal(h.state.selectCalls, 1);
	// exemption now active — no second dialog
	assert.equal((await h.toolCall(readEnv)).block, false);
	assert.equal(h.state.selectCalls, 1);
});

test("continue: interactive 'Keep blocked' is remembered for the turn", async () => {
	const h = await boot(continueExt, fixtureCwd(), {
		hasUI: true,
		select: () => "Keep blocked",
	});
	const res = await h.toolCall(readEnv);
	assert.equal(res.block, true);
	assert.match(res.reason, /kept the block/);
	assert.equal(h.state.selectCalls, 1);
	// same turn → no re-prompt
	assert.equal((await h.toolCall(readEnv)).block, true);
	assert.equal(h.state.selectCalls, 1);
	// next turn → user may be asked again
	await h.agentEnd();
	await h.toolCall(readEnv);
	assert.equal(h.state.selectCalls, 2);
});

test("continue: destructive bash patterns are never exemptible or prompted", async () => {
	const h = await boot(continueExt, fixtureCwd(), { hasUI: true, select: () => "Allow for this session" });
	await h.commands.allow.handler("rm", h.ctx);
	const res = await h.toolCall({ type: "tool_call", toolName: "bash", input: { command: "rm -rf /tmp/x" } });
	assert.equal(res.block, true);
	assert.equal(h.state.selectCalls, 0);
});

test("continue: interactive protected deletion only offers one-call approval", async () => {
	const h = await boot(continueExt, fixtureCwd(), {
		hasUI: true,
		select: (_title, options) => options.find((option) => option === "Allow once"),
	});
	assert.equal((await h.toolCall(deleteReadme)).block, false);
	assert.deepEqual(h.state.selectOptions[0], ["Keep blocked", "Allow once"]);
	assert.equal(h.log.some(({ data }) => data.action === "exemption_granted"), false);
});

function fakeHubServer(socketPath, decision) {
	const seen = [];
	const server = net.createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const req = JSON.parse(buf.slice(0, nl));
			seen.push(req);
			if (decision === null) return; // simulate an unanswered dialog
			socket.write(JSON.stringify({ type: "access_decision", msg_id: req.msg_id, decision }) + "\n");
			socket.end();
		});
	});
	return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, seen })));
}

test("continue: headless child escalates to the hub — approval lets the call through", async () => {
	const sock = join(mkdtempSync(join(tmpdir(), "dc-exemptions-")), "hub.sock");
	const { server, seen } = await fakeHubServer(sock, "allow_agent");
	process.env.AGENT_HUB_ASK_ENDPOINT = sock;
	process.env.AGENT_HUB_AGENT_ID = "researcher-r1";
	try {
		const h = await boot(continueExt, fixtureCwd(), { hasUI: false });
		assert.equal((await h.toolCall(readEnv)).block, false);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].type, "access_request");
		assert.equal(seen[0].agent, "researcher-r1");
		assert.equal(seen[0].pattern, ".env");
		assert.equal(seen[0].category, "zero_access");
		// grant is remembered in-process — no second round-trip
		assert.equal((await h.toolCall(readEnv)).block, false);
		assert.equal(seen.length, 1);
	} finally {
		server.close();
	}
});

test("continue: headless protected deletion requests one-call approval without persisting an exemption", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dc-exemptions-"));
	const sock = join(dir, "hub.sock");
	const exemptionsFile = join(dir, "exemptions.json");
	const { server, seen } = await fakeHubServer(sock, "allow_once");
	process.env.AGENT_HUB_ASK_ENDPOINT = sock;
	process.env.AGENT_HUB_AGENT_ID = "builder";
	process.env.AGENT_HUB_EXEMPTIONS_FILE = exemptionsFile;
	try {
		const h = await boot(continueExt, fixtureCwd(), { hasUI: false });
		assert.equal((await h.toolCall(deleteReadme)).block, false);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].category, "no_delete");
		assert.equal(seen[0].invocation, "rm -- README.md");
		assert.deepEqual(readExemptionsFile(exemptionsFile), []);
	} finally {
		server.close();
	}
});

test("continue: denied protected deletion returns actionable feedback without aborting the child", async () => {
	const sock = join(mkdtempSync(join(tmpdir(), "dc-exemptions-")), "hub.sock");
	const denyHub = await fakeHubServer(sock, "deny");
	process.env.AGENT_HUB_ASK_ENDPOINT = sock;
	process.env.AGENT_HUB_AGENT_ID = "builder";
	try {
		const h = await boot(continueExt, fixtureCwd(), { hasUI: false });
		const res = await h.toolCall(deleteReadme);
		assert.equal(res.block, true);
		assert.equal(h.state.aborted, false);
		assert.match(res.reason, /DENIED/);
		assert.match(res.reason, /rm -- README\.md/);
		assert.equal(denyHub.seen[0].category, "no_delete");
	} finally {
		denyHub.server.close();
	}
});

test("continue: hub denial and timeout fail closed without re-asking", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dc-exemptions-"));
	process.env.AGENT_HUB_AGENT_ID = "researcher-r1";

	const denySock = join(dir, "deny.sock");
	const denyHub = await fakeHubServer(denySock, "deny");
	process.env.AGENT_HUB_ASK_ENDPOINT = denySock;
	try {
		const h = await boot(continueExt, fixtureCwd());
		const res = await h.toolCall(readEnv);
		assert.equal(res.block, true);
		assert.match(res.reason, /DENIED/);
		// denial cached for the turn — no second escalation
		await h.toolCall(readEnv);
		assert.equal(denyHub.seen.length, 1);
	} finally {
		denyHub.server.close();
	}

	const silentSock = join(dir, "silent.sock");
	const silentHub = await fakeHubServer(silentSock, null);
	process.env.AGENT_HUB_ASK_ENDPOINT = silentSock;
	try {
		const h = await boot(continueExt, fixtureCwd());
		const res = await h.toolCall(readEnv);
		assert.equal(res.block, true);
		assert.match(res.reason, /timed out/);
	} finally {
		silentHub.server.close();
	}
});

test("version status persists while continue safety status changes", async () => {
	const continued = await boot(continueExt, fixtureCwd());
	const versionKey = "00-agent-fleet-version";
	const version = continued.state.statuses.get(versionKey);
	assert.match(version, /^v\d+\.\d+\.\d+/);
	await continued.commands.allow.handler(".env turn", continued.ctx);
	assert.equal(continued.state.statuses.get(versionKey), version);
	assert.match(continued.state.statuses.get("damage-control"), /1 exemption/);
	await continued.commands.revoke.handler(".env", continued.ctx);
	assert.equal(continued.state.statuses.get(versionKey), version);
	assert.match(continued.state.statuses.get("damage-control"), /Damage-Control \(continue\): \d+ Rules$/);
});
