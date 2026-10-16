import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const source = fileURLToPath(new URL("./index.ts", import.meta.url));
const registry = JSON.stringify(fileURLToPath(new URL("../../harnesses/agent-hub/context-continuity-registry.ts", import.meta.url)));

test("compact-and-continue imports nothing from the selectable harnesses", () => {
	assert.doesNotMatch(readFileSync(source, "utf8"), /from\s+['"][^'"]*harnesses\//);
});

// Fleet Core installs this extension without Agent Hub; the copy has no harness tree beside it.
async function load(t: any, peer?: string) {
	const dir = mkdtempSync(join(tmpdir(), "compact-continue-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = [join(dir, "compact-and-continue.ts")]; copyFileSync(source, paths[0]);
	if (peer) { paths.push(join(dir, "peer.ts")); writeFileSync(paths[1], peer); }
	const loaded = await loadExtensions(paths, dir); assert.deepEqual(loaded.errors, []);
	const notices: string[] = [], sessionManager = {};
	const ctx: any = { sessionManager, ui: { notify: (text: string) => notices.push(text) } };
	const run = () => (loaded.extensions[0].tools.get("request_compaction")!.definition as any).execute("call", { reason: "checkpoint", continuationPrompt: "Next step" }, undefined, undefined, ctx);
	return { loaded, ctx, notices, run };
}

test("standalone compact-and-continue loads and queues its own compaction without the Hub", async t => {
	const f = await load(t);
	const result = await f.run();
	assert.equal(result.details.queued, true);
	assert.match(f.notices[0], /Compaction queued after the current turn/);
});

test("a Hub controller registered by another extension instance receives the explicit request", async t => {
	const f = await load(t, `import { registerManagedCompaction } from ${registry};
export default function (pi) { pi.registerCommand("bind", { handler: (_args, ctx) => { const requests = []; registerManagedCompaction(ctx.sessionManager, { request: r => requests.push(r) }); return requests; } }); }`);
	const requests = await (f.loaded.extensions[1].commands.get("bind")!.handler as any)("", f.ctx);
	await f.run();
	assert.deepEqual(requests, [{ instructions: "Reason: checkpoint\nPreserve task goal, completed work, changed/read files, decisions, blockers, and next steps.", nextStep: "Next step" }]);
	assert.match(f.notices[0], /Explicit compaction queued/);
});
