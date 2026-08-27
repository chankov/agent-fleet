import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fakeContext(cwd: string, assistantText = "") {
	return {
		cwd,
		model: { id: "test-model" },
		hasUI: false,
		getContextUsage: () => ({ percent: 12 }),
		sessionManager: {
			getBranch: () => assistantText
				? [{ type: "message", message: { role: "assistant", content: assistantText } }]
				: [],
		},
		ui: { notify() {}, setWidget() {}, setStatus() {} },
	} as any;
}

function fakePi(name: string, inbound: any[]) {
	return {
		getFlag(flag: string) { return flag === "name" ? name : flag === "project" ? "test-project" : undefined; },
		getSessionName() { return undefined; },
		appendEntry() {},
		sendMessage(message: any) { inbound.push(message); },
	} as any;
}

test("shared coms peers connect, discover, exchange a reply, and shut down", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-fleet-coms-core-"));
	const previousComsDir = process.env.PI_COMS_DIR;
	process.env.PI_COMS_DIR = root;
	const { createComsPeer } = await import(`./coms-core.ts?test=${Date.now()}`);
	const aliceInbound: any[] = [];
	const bobInbound: any[] = [];
	let aliceContext = fakeContext(root);
	let bobContext = fakeContext(root, "reply from bob");
	const alice = createComsPeer({ pi: fakePi("alice", aliceInbound), getContext: () => aliceContext });
	const bob = createComsPeer({ pi: fakePi("bob", bobInbound), getContext: () => bobContext });

	try {
		await alice.connect({ ctx: aliceContext, defaultNamePrefix: "agent", defaultPurpose: "" });
		await bob.connect({ ctx: bobContext, defaultNamePrefix: "agent", defaultPurpose: "" });

		assert.deepEqual(alice.peersInScope().map(peer => peer.name), ["bob"]);
		const listed = await alice.list();
		assert.equal(listed.agents[0]?.name, "bob");
		assert.equal(listed.agents[0]?.alive, true);

		const sent = await alice.send({ target: "bob", prompt: "hello" });
		assert.equal(bobInbound.length, 1);
		assert.match(bobInbound[0].content, /hello/);
		await bob.respond(bobContext);
		assert.deepEqual(await sent.promise, { response: "reply from bob", error: null });
		assert.deepEqual(alice.get(sent.msg_id), { status: "complete", response: "reply from bob", error: null });
	} finally {
		await Promise.all([alice.shutdown(), bob.shutdown()]);
		if (previousComsDir === undefined) delete process.env.PI_COMS_DIR;
		else process.env.PI_COMS_DIR = previousComsDir;
		await rm(root, { recursive: true, force: true });
	}
});
