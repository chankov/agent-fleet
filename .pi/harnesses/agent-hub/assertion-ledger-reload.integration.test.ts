// Real Pi/RPC: the acceptance ledger survives live compaction and a new extension
// instance on the same saved session. Synthetic fixture; no live model or network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSERTION_LEDGER_ENTRY } from "./context/assertion-journal.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const guard = join(root, "bin/test/helpers/system1-no-network.js");
const SEVEN = [
	{ id: "A1", tag: "test", text: "unit suite passes", source: "PLAN.md:10", test_command: "node --test unit.test.js" },
	{ id: "A2", tag: "test", text: "integration suite passes", source: "PLAN.md:11", test_command: "node --test integration.test.js" },
	{ id: "A3", tag: "compiler", text: "typecheck clean", source: "PLAN.md:12", compiler_command: "tsc --noEmit -p fixture.json" },
	{ id: "A4", tag: "code-grep", text: "no legacy call", source: "review F1", critical_conditions: ["no match under src/"] },
	{ id: "A5", tag: "manual", text: "operator confirms the dialog", source: "user request" },
	{ id: "A6", tag: "manual", text: "docs describe the flag", source: "user request", reference: "§3" },
	{ id: "A7", tag: "manual", text: "release note written", source: "user request" },
];

// The fake model calls set_assertions for DECLARE and get_assertions for INSPECT.
const probe = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
let seq = 0;
export default function (pi) {
 pi.registerProvider("ledger-fixture", { name: "ledger-fixture", baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "ledger-fixture-api",
  models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2000 }],
  streamSimple(model, ctx) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const messages = ctx.messages ?? [], last = messages.at(-1);
    // Pi's own summarization requests (history and split-turn prefix) must not call tools.
    const wire = JSON.stringify(ctx);
    const compact = wire.includes("context summarization assistant") || wire.includes("Create a concise checkpoint") || wire.includes("ledger fixture compaction");
    const userText = last?.role === "user" ? JSON.stringify(last.content) : "";
    const msg = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    stream.push({ type: "start", partial: msg });
    const tool = compact ? null : userText.includes("DECLARE") ? { name: "set_assertions", arguments: { assertions: ${JSON.stringify(SEVEN)} } } : userText.includes("INSPECT") ? { name: "get_assertions", arguments: {} } : null;
    if (tool) {
     const tc = { type: "toolCall", id: "ledger-" + process.pid + "-" + (++seq), ...tool };
     msg.content.push(tc); msg.stopReason = "toolUse";
     stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
     stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tc, partial: msg });
    } else {
     const text = compact ? "Offline ledger fixture compaction summary" : "Fixture turn complete";
     msg.content.push({ type: "text", text });
     stream.push({ type: "text_start", contentIndex: 0, partial: msg });
     stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
     stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    }
    stream.push({ type: "done", reason: msg.stopReason, message: msg }); stream.end();
   });
   return stream;
  } });
}
`;

function harness(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "ledger-reload-"));
	mkdirSync(join(dir, "home")); mkdirSync(join(dir, "agent"));
	writeFileSync(join(dir, "agent/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	writeFileSync(join(dir, "probe.ts"), probe);
	const processes: Array<() => Promise<void>> = [];
	t.after(async () => { try { for (const close of processes.reverse()) await close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
	const start = (sessionFile?: string) => {
		const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", TMPDIR: dir, NODE_OPTIONS: `--import=${guard}` };
		const child = spawn(join(root, "node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--session-dir", join(dir, "sessions"),
			...(sessionFile ? ["--session", sessionFile] : []),
			"-e", join(root, ".pi/harnesses/damage-control-continue/index.ts"), "-e", join(root, ".pi/harnesses/agent-hub/index.ts"), "-e", join(dir, "probe.ts"),
			"--solo", "--model", "ledger-fixture/m"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		let buffer = "", stderr = "", settled = 0, ended = false;
		const pending = new Map<string, (value: any) => void>(); const waiters = new Set<() => void>();
		child.stderr!.on("data", chunk => { stderr += String(chunk); });
		child.stdout!.on("data", chunk => {
			buffer += String(chunk);
			for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
				const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
				let event: any; try { event = JSON.parse(line); } catch { continue; }
				if (event.type === "agent_settled") { settled++; for (const wake of waiters) wake(); }
				if (event.type === "response" && pending.has(event.id)) { pending.get(event.id)!(event); pending.delete(event.id); }
			}
		});
		const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
			ended = true; for (const wake of waiters) wake();
			for (const wake of pending.values()) wake({ success: false, error: `Pi exited: ${stderr}` }); pending.clear();
			resolve({ code, signal });
		}));
		let seq = 0;
		const rpc = async (command: Record<string, unknown>, awaitTurn = false) => {
			const before = settled, id = `ledger-${++seq}`;
			const response = await new Promise<any>((resolve, reject) => {
				if (ended) return reject(new Error(`Pi exited: ${stderr}`));
				const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${command.type} timed out: ${stderr}`)); }, 30_000);
				pending.set(id, value => { clearTimeout(timeout); resolve(value); });
				child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
			});
			assert.equal(response.success, true, `RPC ${command.type}: ${JSON.stringify(response)} ${stderr}`);
			if (awaitTurn && settled <= before) await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => { waiters.delete(wake); reject(new Error(`agent_settled timed out: ${stderr}`)); }, 60_000);
				const wake = () => { if (settled <= before && !ended) return; clearTimeout(timeout); waiters.delete(wake); ended ? reject(new Error(stderr)) : resolve(); };
				waiters.add(wake); wake();
			});
			return response.data;
		};
		const close = async () => {
			if (!ended) child.stdin!.end();
			const timeout = setTimeout(() => { if (child.pid && !ended) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 5000);
			const exit = await finished; clearTimeout(timeout);
			assert.deepEqual(exit, { code: 0, signal: null }, `Pi exits cleanly: ${stderr}`);
		};
		processes.push(close);
		const entries = async () => (await rpc({ type: "get_entries" })).entries as any[];
		const inspect = async () => {
			await rpc({ type: "prompt", message: "INSPECT the acceptance assertions" }, true);
			const results = (await entries()).filter(e => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "get_assertions");
			return { text: String(results.at(-1)?.message?.content?.[0]?.text ?? ""), details: results.at(-1)?.message?.details };
		};
		return { rpc, close, entries, inspect };
	};
	return { dir, start };
}

const ledgerRows = (entries: any[]) => entries.filter(e => e.customType === ASSERTION_LEDGER_ENTRY);
const taskRows = (entries: any[]) => entries.filter(e => e.customType === "agent-hub-recover-event" && e.data?.kind === "guard" && e.data.event?.type === "task");
function assertSeven(text: string, label: string) {
	for (const a of SEVEN) assert.match(text, new RegExp(`${a.id} \\[${a.tag}\\] OPEN`), `${label}: ${a.id} present and open\n${text}`);
	assert.match(text, /test command: "node --test unit.test.js"/, label); assert.match(text, /compiler command: "tsc --noEmit -p fixture.json"/, label);
	assert.match(text, /critical: no match under src\//, label); assert.match(text, /user request · §3/, label);
}

test("real Pi keeps the same task's seven assertions across live compaction and a resumed extension instance", { timeout: 180_000 }, async t => {
	const { start } = harness(t);
	const first = start();
	await first.rpc({ type: "prompt", message: "DECLARE the acceptance assertions" }, true);
	let entries = await first.entries();
	assert.equal(ledgerRows(entries).length, 1, "set_assertions appends one authoritative snapshot");
	assert.equal(taskRows(entries).length, 1, "the first task identity is journaled with the ledger");
	assert.equal(ledgerRows(entries)[0].data.taskId, taskRows(entries)[0].data.event.taskId);
	assertSeven((await first.inspect()).text, "before compaction");
	const compact = await first.rpc({ type: "compact", customInstructions: "ledger fixture compaction" });
	assert.match(compact.summary, /Offline ledger fixture compaction summary/);
	assert.ok((await first.entries()).some(e => e.type === "compaction"), "Pi appended a real compaction entry");
	assertSeven((await first.inspect()).text, "live runtime after compaction");
	const sessionFile = (await first.rpc({ type: "get_state" })).sessionFile;
	await first.close();
	assert.ok(existsSync(sessionFile));

	const second = start(sessionFile);
	entries = await second.entries();
	const before = ledgerRows(entries).length;
	const resumed = await second.inspect();
	assertSeven(resumed.text, "resumed extension instance");
	entries = await second.entries();
	assert.equal(ledgerRows(entries).length, before, "a snapshot restore does not append a migration record");
	assert.equal(taskRows(entries).length, 1, "resume keeps the same task identity");
	await second.close();
});

test("real Pi migrates a pre-snapshot session's typed set_assertions once, as open declarations", { timeout: 180_000 }, async t => {
	const { start } = harness(t);
	const first = start();
	await first.rpc({ type: "prompt", message: "DECLARE the acceptance assertions" }, true);
	const sessionFile = (await first.rpc({ type: "get_state" })).sessionFile;
	await first.close();
	// Model a session written by the previous module: same entry chain, no ledger snapshot.
	const legacy = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => {
		const row = JSON.parse(line);
		if (row.customType === ASSERTION_LEDGER_ENTRY) row.customType = "fixture-pre-snapshot-placeholder";
		return JSON.stringify(row);
	}).join("\n") + "\n";
	writeFileSync(sessionFile, legacy);

	const second = start(sessionFile);
	const migrated = await second.inspect();
	assertSeven(migrated.text, "migrated legacy session");
	const entries = await second.entries();
	assert.equal(ledgerRows(entries).length, 1, "the migration writes exactly one authoritative snapshot");
	assert.ok(ledgerRows(entries)[0].data.assertions.every((a: any) => a.status === "open" && !a.evidence), "no proof is migrated");
	await second.close();
});
