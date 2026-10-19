import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function shortTmp(prefix: string): Promise<string> {
	// Darwin sockaddr_un is 104 bytes; GHA macOS tmpdir is already ~50 chars.
	const base = process.platform === "darwin" ? "/tmp" : tmpdir();
	return mkdtemp(join(base, prefix));
}

test("coms serializes inbound turns, reports truthful state, and correlates replies", async t => {
	const root = await shortTmp("afc-");
	const previousComsDir = process.env.PI_COMS_DIR;
	const previousHerdr = process.env.HERDR_ENV;
	process.env.PI_COMS_DIR = root;
	process.env.HERDR_ENV = "0";
	const { createComsPeer, removeRegistryEntry, sendEnvelope, writeRegistryAtomic } = await import(`./coms-core.ts?test=${Date.now()}`);
	const project = `test-${Date.now()}`;

	function harness(name: string) {
		const branch: any[] = [];
		const deliveries: string[] = [];
		let deliveryError: Error | null = null;
		const pi = {
			getFlag(flag: string) { return flag === "name" ? name : flag === "project" ? project : undefined; },
			getSessionName() { return undefined; },
			appendEntry() {},
			sendMessage(message: any) {
				if (deliveryError) throw deliveryError;
				deliveries.push(message.details.msg_id);
				branch.push({ type: "custom_message", customType: message.customType, details: message.details });
			},
		} as any;
		const ctx = {
			cwd: root,
			model: { id: "test-model" },
			hasUI: false,
			getContextUsage: () => ({ percent: 12 }),
			sessionManager: { getBranch: () => branch },
			ui: { notify() {}, setWidget() {}, setStatus() {} },
		} as any;
		const peer = createComsPeer({ pi, getContext: () => ctx });
		return {
			branch,
			ctx,
			deliveries,
			peer,
			failDelivery(error: Error) { deliveryError = error; },
		};
	}

	const receiver = harness("receiver");
	const sender = harness("sender");
	t.after(async () => {
		await Promise.all([sender.peer.shutdown(), receiver.peer.shutdown()]);
		if (previousComsDir === undefined) delete process.env.PI_COMS_DIR;
		else process.env.PI_COMS_DIR = previousComsDir;
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
		await rm(root, { recursive: true, force: true });
	});

	await receiver.peer.connect({ ctx: receiver.ctx, defaultNamePrefix: "agent", defaultPurpose: "" });
	await sender.peer.connect({ ctx: sender.ctx, defaultNamePrefix: "agent", defaultPurpose: "" });
	assert.deepEqual(sender.peer.peersInScope().map((peer: any) => peer.name), ["receiver"]);
	const listed = await sender.peer.list();
	assert.equal(listed.agents[0]?.name, "receiver");
	assert.equal(listed.agents[0]?.alive, true);
	receiver.peer.setTurnState("working");

	const first = await sender.peer.send({ target: "receiver", prompt: "first" });
	const second = await sender.peer.send({ target: "receiver", prompt: "second" });
	await assert.rejects(
		() => sendEnvelope(sender.peer.identity!.endpoint, {
			type: "response",
			msg_id: first.msg_id,
			sender_session: "forged-session",
			sender_endpoint: "forged-endpoint",
			hops: 0,
			timestamp: new Date().toISOString(),
			response: "forged response",
		}),
		/response sender mismatch/,
	);
	assert.deepEqual(receiver.deliveries, []);
	assert.equal(sender.peer.get(first.msg_id).status, "pending");
	assert.equal(sender.peer.get(second.msg_id).status, "pending");

	let card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "working");
	assert.equal(card?.queue_depth, 2);

	receiver.peer.setTurnState("idle");
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "queued");
	assert.equal(card?.queue_depth, 2);

	await receiver.peer.settleTurn(receiver.ctx);
	assert.deepEqual(receiver.deliveries, [first.msg_id]);
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "queued");
	assert.equal(card?.queue_depth, 1);

	receiver.branch.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first response" }] },
	});
	receiver.peer.setTurnState("working");
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "working");
	assert.equal(card?.queue_depth, 1);
	await receiver.peer.settleTurn(receiver.ctx, { dispatchQueued: false });
	assert.deepEqual(receiver.deliveries, [first.msg_id]);
	assert.deepEqual(sender.peer.get(first.msg_id), { status: "complete", response: "first response", error: null });
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "queued");
	assert.equal(card?.queue_depth, 1);
	const duringPressure = await sender.peer.send({ target: "receiver", prompt: "arrived during pressure settlement" });
	assert.deepEqual(receiver.deliveries, [first.msg_id]);
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "queued");
	assert.equal(card?.queue_depth, 2);
	receiver.peer.dispatchQueued();
	assert.deepEqual(receiver.deliveries, [first.msg_id, second.msg_id]);
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "queued");
	assert.equal(card?.queue_depth, 1);

	receiver.branch.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second response" }] },
	});
	receiver.peer.setTurnState("working");
	await receiver.peer.settleTurn(receiver.ctx);
	assert.deepEqual(sender.peer.get(second.msg_id), { status: "complete", response: "second response", error: null });
	assert.deepEqual(receiver.deliveries, [first.msg_id, second.msg_id, duringPressure.msg_id]);

	receiver.branch.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "post-pressure response" }] },
	});
	receiver.peer.setTurnState("working");
	await receiver.peer.settleTurn(receiver.ctx);
	assert.deepEqual(sender.peer.get(duringPressure.msg_id), { status: "complete", response: "post-pressure response", error: null });

	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "idle");
	assert.equal(card?.queue_depth, 0);

	const unsuccessful = await sender.peer.send({ target: "receiver", prompt: "fail safely" });
	receiver.branch.push({
		type: "message",
		message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "private provider failure" }] },
	});
	receiver.peer.setTurnState("working");
	await receiver.peer.settleTurn(receiver.ctx);
	assert.deepEqual(await unsuccessful.promise, {
		response: null,
		error: "peer agent ended without a successful final answer",
	});

	const invalidJson = await sender.peer.send({
		target: "receiver",
		prompt: "return structured data",
		response_schema: { type: "object" },
	});
	receiver.branch.push({
		type: "message",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "not-json" }] },
	});
	receiver.peer.setTurnState("working");
	await receiver.peer.settleTurn(receiver.ctx);
	assert.deepEqual(await invalidJson.promise, { response: null, error: "response not valid JSON" });

	writeRegistryAtomic({
		session_id: "booting-session",
		name: "booting-peer",
		purpose: "test booting projection",
		model: "test-model",
		color: "#36F9F6",
		pid: process.pid,
		endpoint: join(root, "missing-booting-endpoint.sock"),
		cwd: root,
		started_at: new Date().toISOString(),
		explicit: false,
		version: 1,
	}, project);
	const withBooting = await sender.peer.list();
	const booting = withBooting.agents.find((agent: any) => agent.name === "booting-peer");
	assert.equal(booting?.alive, false);
	assert.equal(booting?.status, "booting");
	removeRegistryEntry(project, "booting-peer");

	receiver.failDelivery(new Error("synthetic delivery failure"));
	const failed = await sender.peer.send({ target: "receiver", prompt: "cannot deliver" });
	assert.deepEqual(await failed.promise, {
		response: null,
		error: "peer agent could not start the queued turn",
	});
	card = await sender.peer.ping(receiver.peer.identity!.endpoint);
	assert.equal(card?.status, "idle");
	assert.equal(card?.queue_depth, 0);
});
