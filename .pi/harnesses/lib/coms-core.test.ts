import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {after} from "node:test";

function shortTmp(prefix: string): Promise<string> {
	// Darwin sockaddr_un is 104 bytes; GHA macOS tmpdir is already ~50 chars.
	const base = process.platform === "darwin" ? "/tmp" : tmpdir();
	return mkdtemp(join(base, prefix));
}

// coms-core-io caches its root at module load. Both sequential cases must use
// the same disposable root even though they import distinct core URL queries.
const fixtureComsRoot = await shortTmp("afc-");
after(()=>rm(fixtureComsRoot,{recursive:true,force:true}));

test("coms serializes inbound turns, reports truthful state, and correlates replies", async t => {
	const root = fixtureComsRoot;
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

	// PLAN-11-01: review protocol v1 now follows the `reviewer` role (isReviewPersona);
	// two distinct reviewers are `reviewer` and its parallel instance `reviewer--p2`.
	for (const name of ['reviewer', 'reviewer--p2']) await t.test(`P16 ${name} timeout preserves one Pi request until its correlated verdict`, async () => {
		const { createDispatchComs } = await import("../agent-hub/dispatch-coms.ts");
		const hub = createDispatchComs({
			getIdentity: () => sender.peer.identity, resolveTarget: sender.peer.resolveTarget,
			send: sender.peer.send, getPendingReply: (id: string) => sender.peer.pendingReplies.get(id),
			getSessionDir: () => root, safePathWithin: join, safeAgentKey: (s: string) => s,
			appendInputArtifacts: (s: string) => s, appendDeclaredScope: (s: string) => s,
			buildRulesProtocol: () => '', buildDocsProtocol: () => '', updateWidget() {},
		} as any);
		const before = receiver.deliveries.length;
		const result = await hub.dispatchViaComs({ def: { name }, runCount: 1, contextPct: 0, lastWork: '' }, 'review', 'receiver', 10, false, sender.ctx, [], []);
		const id = receiver.deliveries[before];
		assert.ok(id && result?.pending && result.output.includes(id));
		for (const phase of ['progress', 'final']) {
			receiver.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: '```json\n' + JSON.stringify({ msg_id: id, phase, verdict: 'APPROVE', report: 'checked' }) + '\n```' } });
			await receiver.peer.settleTurn(receiver.ctx);
			if (phase !== 'final') assert.equal((await sender.peer.await(id, 1)).status, 'pending');
		}
		assert.deepEqual(sender.peer.get(id), { status: 'complete', response: 'checked\nVerdict: APPROVE', error: null });
		assert.deepEqual(await sender.peer.await(id, 1), { status: 'complete', response: 'checked\nVerdict: APPROVE' });
		await sendEnvelope(sender.peer.identity!.endpoint, { type: 'response', msg_id: id, sender_session: receiver.peer.identity!.session_id, sender_endpoint: receiver.peer.identity!.endpoint, hops: 0, timestamp: new Date().toISOString(), error: null, response: JSON.stringify({ msg_id: id, phase: 'final', verdict: 'REJECT', report: 'duplicate' }) });
		assert.equal(sender.peer.get(id).response, 'checked\nVerdict: APPROVE');
		assert.deepEqual(receiver.deliveries.slice(before), [id, id]);
	});

	await t.test('settled incomplete review gets one follow-up and releases the queue on failure', async () => {
		const before = receiver.deliveries.length;
		const review = await sender.peer.send({ target: 'receiver', prompt: 'review', review_protocol: 'v1' });
		const next = await sender.peer.send({ target: 'receiver', prompt: 'next' });
		const progress = { type: 'message', message: { role: 'assistant', stopReason: 'stop',
			content: JSON.stringify({ msg_id: review.msg_id, phase: 'progress' }) } };
		receiver.branch.push(progress);
		await receiver.peer.settleTurn(receiver.ctx, { dispatchQueued: false });
		assert.deepEqual(receiver.deliveries.slice(before), [review.msg_id]);
		receiver.peer.dispatchQueued();
		assert.deepEqual(receiver.deliveries.slice(before), [review.msg_id, review.msg_id]);
		receiver.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
			content: JSON.stringify({ msg_id: 'foreign', phase: 'final', verdict: 'APPROVE', report: 'another review' }) } });
		await receiver.peer.settleTurn(receiver.ctx);
		assert.match((await sender.peer.await(review.msg_id, 1)).error ?? '', /wrong_id/);
		assert.deepEqual(receiver.deliveries.slice(before), [review.msg_id, review.msg_id, next.msg_id]);
		receiver.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'done' } });
		await receiver.peer.settleTurn(receiver.ctx);
		assert.equal(sender.peer.get(next.msg_id).response, 'done');
	});

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

	// A peer can accept the prompt and disconnect before its ACK reaches the Hub.
	const endpoint = join(root, "lost-ack.sock");
	const { createServer } = await import("node:net");
	let accepted = 0;
	const server = createServer(socket => socket.once("data", () => { accepted++; socket.destroy(); }));
	await new Promise<void>(resolve => server.listen(endpoint, resolve));
	try {
		writeRegistryAtomic({
			session_id: "lost-ack", name: "lost-ack", purpose: "test", model: "test-model",
			color: "#36F9F6", pid: process.pid, endpoint, cwd: root, started_at: new Date().toISOString(), explicit: false, version: 1,
		}, project);
		const unknown = await sender.peer.send({ target: "lost-ack", prompt: "run once", await_reply_on_lost_ack: true });
		assert.equal(sender.peer.get(unknown.msg_id).status, "pending");
		await sendEnvelope(sender.peer.identity!.endpoint, {
			type: "response", msg_id: unknown.msg_id, sender_session: "lost-ack", sender_endpoint: endpoint,
			hops: 0, timestamp: new Date().toISOString(), response: "late result", error: null,
		});
		assert.deepEqual(await unknown.promise, { response: "late result", error: null });
		assert.equal(accepted, 1);
	} finally {
		removeRegistryEntry(project, "lost-ack");
		await new Promise<void>(resolve => server.close(() => resolve()));
	}

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

test('S6a native owner gate precedes enqueue; capability, terminal lookup and legacy coexist', async t => {
 const root=fixtureComsRoot,old=process.env.PI_COMS_DIR,herdr=process.env.HERDR_ENV;process.env.PI_COMS_DIR=root;process.env.HERDR_ENV='0';
 const{createComsPeer,sendEnvelope}=await import(`./coms-core.ts?s6a=${Date.now()}`);const{handleInstructionReceipt,ownerOf}=await import('./coms-instruction-receipts.ts');
 const branch:any[]=[],deliveries:string[]=[];const add=(e:any)=>branch.push({...e,id:String(branch.length),parentId:branch.length?String(branch.length-1):null});
 const manager={getBranch:()=>branch,getLeafId:()=>branch.at(-1)?.id??null,getEntry:(id:string)=>branch[Number(id)]};
 let peer:any;const ctx:any={cwd:root,model:{id:'fixture'},hasUI:false,getContextUsage:()=>null,sessionManager:manager,ui:{notify(){},setWidget(){},setStatus(){}}};
 const pi:any={getFlag:(f:string)=>f==='name'?'receiver':f==='project'?'fixture':undefined,getSessionName:()=>undefined,appendEntry:(customType:string,data:any)=>add({type:'custom',customType,data}),sendMessage:(m:any)=>{deliveries.push(m.details.msg_id);add({type:'custom_message',customType:m.customType,details:m.details});}};
 peer=createComsPeer({pi,getContext:()=>ctx,instructionReceipts:true,handleCustomEnvelope:(socket:any,e:any)=>handleInstructionReceipt(e,socket,()=>peer.identity?ownerOf(peer.identity):null,manager)});
 t.after(async()=>{await peer.shutdown();if(old===undefined)delete process.env.PI_COMS_DIR;else process.env.PI_COMS_DIR=old;if(herdr===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=herdr;await rm(root,{recursive:true,force:true});});await peer.connect({ctx,defaultNamePrefix:'fixture',defaultPurpose:''});assert.ok(peer.identity.endpoint.startsWith(root+'/'));const owner=ownerOf(peer.identity),wire='c'.repeat(64);
 const {subscribeFleetSourceEvents}=await import('./fleet-event-source.ts');const events:any[]=[];let rejectResponses=false;
 t.after(subscribeFleetSourceEvents(owner,e=>{if(rejectResponses&&e.sourceId.startsWith('response-v1-'))throw Error('fixture notification failure');events.push(e);return {status:'ingested',eventId:'event-'+events.length};}));
 const base:any={sender_session:'fake-sender',sender_endpoint:join(root,'absent.sock'),hops:0,timestamp:new Date().toISOString()};
 const pong=await sendEnvelope(peer.identity.endpoint,{...base,type:'ping',msg_id:'probe'});assert.equal(pong.instruction.version,1);assert.deepEqual(pong.instruction.owner,owner);
 for(const bad of [{...owner,project:'other'},{...owner,peer:'other'},{...owner,sessionId:'other'},{...owner,startedAt:'2026-01-01T00:00:00Z'}])await assert.rejects(()=>sendEnvelope(peer.identity.endpoint,{...base,type:'prompt',msg_id:wire,prompt:'fixture',instruction:{version:1,owner:bad}}),/owner/);
 assert.deepEqual(deliveries,[]);await assert.rejects(()=>sendEnvelope(peer.identity.endpoint,{...base,type:'prompt',msg_id:wire,prompt:'fixture',instruction:{version:1}}),/owner/);assert.deepEqual(deliveries,[]);
 const ack=await sendEnvelope(peer.identity.endpoint,{...base,type:'prompt',msg_id:wire,prompt:'fixture',instruction:{version:1,owner}});assert.equal(ack.instruction.version,1);assert.equal(deliveries.length,1);
 add({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'PRIVATE'},{type:'text',text:'token=SECRET done'}]}});await peer.settleTurn(ctx);
 const receipt=await sendEnvelope(peer.identity.endpoint,{type:'instruction_receipt_request',msg_id:'lookup1',version:1,owner,wireId:wire,sender_session:'fake',sender_endpoint:''});assert.equal(receipt.status,'available');assert.equal(receipt.receipt.wireId,wire);assert.equal(receipt.receipt.text.includes('SECRET'),false);assert.equal(receipt.receipt.text.includes('PRIVATE'),false);
 const {responseReference,responseHash}=await import('./coms-response-read.ts');
 const full=await sendEnvelope(peer.identity.endpoint,{type:'response_read_request',version:1,msg_id:'read-full',owner,reference:responseReference(owner,wire),scope:responseHash('chat'),sender_session:'fake',sender_endpoint:''});
 assert.equal(full.status,'available');assert.equal(full.page.text,'token=[REDACTED] done');assert.equal(full.page.eof,true);
 const ready=events.filter(e=>e.sourceId.startsWith('response-v1-'));assert.equal(ready.length,1);assert.equal('fleet:message/'+ready[0].sourceId,full.page.reference);assert.equal(ready[0].contentDigest,full.page.sourceSha256);assert.ok(ready[0].sourceId.length<=96);assert.notEqual(ready[0].sourceId,wire);
 await peer.settleTurn(ctx);assert.equal(events.filter(e=>e.sourceId.startsWith('response-v1-')).length,1);
 rejectResponses=true;const secondWire='b'.repeat(64);await sendEnvelope(peer.identity.endpoint,{...base,type:'prompt',msg_id:secondWire,prompt:'second',instruction:{version:1,owner}});add({type:'message',message:{role:'assistant',content:[{type:'text',text:'second answer'}],stopReason:'stop'}});await peer.settleTurn(ctx);
 const second=await sendEnvelope(peer.identity.endpoint,{type:'response_read_request',version:1,msg_id:'read-second',owner,reference:responseReference(owner,secondWire),scope:responseHash('chat'),sender_session:'fake',sender_endpoint:''});assert.equal(second.page.text,'second answer');assert.ok(branch.some(e=>e.customType==='coms-response-notification'));
 await sendEnvelope(peer.identity.endpoint,{...base,type:'prompt',msg_id:'legacy',prompt:'legacy'});assert.equal(deliveries.at(-1),'legacy');
});

// ── read_only declaration (PLAN-11-01, decision D3) ──

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const COMS_TOOLS = ["coms_list", "coms_send", "coms_get", "coms_await"];
const READ_ONLY_ARGV = ["node", "pi", "--no-extensions", "-e", "coms/index.ts", "--coms-read-only", "--tools", READ_ONLY_TOOLS.join(","), "--no-mcp"];
const toolsPi = (active: string[], registered = active) => ({ getActiveTools: () => active, getAllTools: () => registered.map(name => ({ name })) });

test("read-only evidence requires a plain --tools allowlist and read-only registered and active tools", async () => {
	const { assessReadOnlyToolSet, launchToolAllowlist } = await import("./coms-core-io.ts");
	assert.deepEqual(launchToolAllowlist(READ_ONLY_ARGV), READ_ONLY_TOOLS);
	assert.deepEqual(launchToolAllowlist(["pi", "-t", "read", "--", "--tools", "bash"]), ["read"], "argv after -- is not pi's");
	assert.equal(launchToolAllowlist(["pi", "--exclude-tools", "bash"]), null);

	assert.equal(assessReadOnlyToolSet(toolsPi(READ_ONLY_TOOLS), READ_ONLY_ARGV).ok, true);
	assert.equal(assessReadOnlyToolSet(toolsPi(["read", "ls"]), ["pi", "--tools", "read,ls"]).ok, true, "a narrower set is fine");
	const refusals: Array<[string, ReturnType<typeof toolsPi> | object, string[], RegExp]> = [
		["default pi tools", toolsPi(["read", "bash", "edit", "write"]), READ_ONLY_ARGV, /active|registered/],
		["read-only active, bash still registered", toolsPi(["read"], ["read", "bash"]), READ_ONLY_ARGV, /registered: bash/],
		["no launch allowlist", toolsPi(["read"]), ["node", "pi", "--coms-read-only"], /not launched with a --tools allowlist/],
		["allowlist names a writer", toolsPi(["read"]), ["pi", "--tools", "read,bash"], /permits non-read-only tools: bash/],
		["allowlist pattern", toolsPi(["read"]), ["pi", "--tools", "read,coms_*"], /not a plain name list/],
		["allowlist modifier", toolsPi(["read"]), ["pi", "--tools", "+coms_send"], /not a plain name list/],
		["MCP tool registered", toolsPi(["read"], ["read", "mcp__srv__write"]), READ_ONLY_ARGV, /mcp__srv__write/],
		// A read-only peer must not ask a writable peer to act: coms tools disqualify too.
		["coms tools active", toolsPi([...READ_ONLY_TOOLS, ...COMS_TOOLS]), READ_ONLY_ARGV, /registered: coms_await, coms_get, coms_list, coms_send/],
		["allowlist names coms_send", toolsPi(READ_ONLY_TOOLS), ["pi", "--tools", "read,grep,find,ls,coms_send"], /permits non-read-only tools: coms_send/],
		["no introspection", {}, READ_ONLY_ARGV, /does not expose getActiveTools/],
	];
	for (const [label, pi, argv, reason] of refusals) {
		const evidence = assessReadOnlyToolSet(pi as any, argv);
		assert.equal(evidence.ok, false, label);
		assert.match((evidence as { reason: string }).reason, reason, label);
	}
});

test("a pi peer declares read_only only when its own tool state proves it, and heartbeats keep it", async t => {
	const root = fixtureComsRoot;
	const previousComsDir = process.env.PI_COMS_DIR;
	const previousHerdr = process.env.HERDR_ENV;
	process.env.PI_COMS_DIR = root;
	process.env.HERDR_ENV = "0";
	const { createComsPeer } = await import(`./coms-core.ts?readonly=${Date.now()}`);
	const { readFileSync } = await import("node:fs");
	const project = `ro-${Date.now()}`;
	const peers: any[] = [];

	async function start(name: string, opts: { requested: boolean; active: string[]; registered?: string[]; argv?: string[] }) {
		const pi = {
			getFlag(flag: string) { return flag === "name" ? name : flag === "project" ? project : flag === "coms-read-only" ? opts.requested : undefined; },
			getSessionName() { return undefined; },
			appendEntry() {},
			sendMessage() {},
			...toolsPi(opts.active, opts.registered),
		} as any;
		const ctx = { cwd: root, model: { id: "test-model" }, hasUI: false, getContextUsage: () => ({ percent: 1 }), sessionManager: { getBranch: () => [] }, ui: { notify() {}, setWidget() {}, setStatus() {} } } as any;
		const peer = createComsPeer({ pi, getContext: () => ctx, launchArgv: opts.argv ?? READ_ONLY_ARGV });
		peers.push(peer);
		await peer.connect({ ctx, defaultNamePrefix: "agent", defaultPurpose: "" });
		return peer;
	}
	const onDisk = (peer: any) => JSON.parse(readFileSync(peer.identity.registryFile, "utf8"));
	t.after(async () => {
		await Promise.all(peers.map(peer => peer.shutdown()));
		if (previousComsDir === undefined) delete process.env.PI_COMS_DIR;
		else process.env.PI_COMS_DIR = previousComsDir;
		if (previousHerdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdr;
		await rm(root, { recursive: true, force: true });
	});

	// Asked to be read-only, but the session kept pi's default tools.
	const writable = await start("asked-ro", { requested: true, active: ["read", "bash", "edit", "write", ...COMS_TOOLS] });
	assert.equal(Object.hasOwn(onDisk(writable), "read_only"), false, "a failed check publishes no claim");
	assert.equal(writable.identity.read_only, undefined);
	assert.match(writable.readOnlyRefusal ?? "", /bash/);

	// Read-only active set, but launched without an allowlist: not fixed at launch.
	const unfixed = await start("unfixed-ro", { requested: true, active: ["read"], argv: ["node", "pi", "--coms-read-only"] });
	assert.equal(Object.hasOwn(onDisk(unfixed), "read_only"), false);
	assert.match(unfixed.readOnlyRefusal ?? "", /--tools allowlist/);

	// The earlier allowlist (inspection + coms tools) no longer qualifies.
	const chatty = await start("chatty-ro", { requested: true, active: [...READ_ONLY_TOOLS, ...COMS_TOOLS], argv: ["pi", "--tools", [...READ_ONLY_TOOLS, ...COMS_TOOLS].join(",")] });
	assert.equal(Object.hasOwn(onDisk(chatty), "read_only"), false);
	assert.match(chatty.readOnlyRefusal ?? "", /coms_send/);

	// Read-only tools without the request: default behavior, no field.
	const quiet = await start("not-asked", { requested: false, active: READ_ONLY_TOOLS });
	assert.equal(Object.hasOwn(onDisk(quiet), "read_only"), false);
	assert.equal(quiet.readOnlyRefusal, null);

	// Requested and proven.
	const reviewer = await start("reviewer-ro", { requested: true, active: READ_ONLY_TOOLS });
	assert.equal(onDisk(reviewer).read_only, true);
	assert.equal(reviewer.readOnlyRefusal, null);
	reviewer.writeLiveRegistry();
	writable.writeLiveRegistry();
	assert.equal(onDisk(reviewer).read_only, true, "the heartbeat carries the claim forward");
	assert.equal(Object.hasOwn(onDisk(writable), "read_only"), false, "the heartbeat does not invent it");

	// What the Hub reads: coms.peersInScope() entries.
	const seen = Object.fromEntries(quiet.peersInScope().map((entry: any) => [entry.name, entry.read_only]));
	assert.deepEqual(seen, { "asked-ro": undefined, "unfixed-ro": undefined, "chatty-ro": undefined, "reviewer-ro": true });
});
