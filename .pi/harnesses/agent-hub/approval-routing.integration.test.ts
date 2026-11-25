import {createHash} from 'node:crypto';
import {PermissionRelay} from './permission-relay.ts';
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readExemptionsFile, type AccessRequest } from "../lib/damage-control-shared.ts";
import { createAccessApprovalRouter } from "./access-approval.ts";

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
	return {
		type: "access_request",
		msg_id: "request-1",
		sender_session: "builder",
		sender_endpoint: "",
		hops: 0,
		timestamp: new Date(0).toISOString(),
		agent: "builder",
		tool: "bash",
		rule: "Bash command attempts to delete/move protected path: .github/",
		pattern: ".github/",
		category: "no_delete",
		invocation: "rm -- .github/workflows/test.yml",
		...overrides,
	};
}

function bind(req:AccessRequest,input:unknown) {
 const exactAction={tool:req.tool,category:req.category,pattern:req.pattern,cwd:process.cwd(),input};
 return {...req,exactAction,actionDigest:createHash('sha256').update(JSON.stringify(exactAction)).digest('hex')};
}

test('relay dispatcher identifies each Docker request without logging its command',async()=>{
 const titles:string[]=[],logs:unknown[]=[];
 const relay=new PermissionRelay(()=>({project:'fixture',peer:'hub',sessionId:'dispatcher',startedAt:'2026-01-01T00:00:00Z'}));
 const router=createAccessApprovalRouter({relay,currentChild:()=>true,taskIdentity:()=>({taskId:'task',inputRevision:'revision'}),getContext:()=>({hasUI:true,ui:{notify(){},async select(title){titles.push(title);return 'Allow once';}}}),getExemptionsFile:()=>null,appendLog:e=>logs.push(e),now:()=>new Date().toISOString()});
 for(const name of ['alpha','auth-token-svc','café','line\nnext']){
  const req=bind(request({msg_id:`ref-${name}`,category:'bash_pattern',pattern:'docker stop',accessEpoch:'spawn'}),{command:`docker stop fixture-${name}`});
  const sock=fakeSocket();await router.handle(sock,req);
  assert.equal(response(sock).decisionSource,'local_human');assert.equal(response(sock).actionDigest,req.actionDigest);
  assert.ok(titles.at(-1)?.includes(req.msg_id));const shown=titles.at(-1)!.split('BEGIN ACTION INPUT JSON\n')[1].split('\nEND ACTION INPUT JSON')[0];
  assert.equal(JSON.parse(shown).command,`docker stop fixture-${name}`);
 }
 assert.doesNotMatch(JSON.stringify(logs),/docker stop fixture-/);
});

function fakeSocket() {
	let output = "";
	return {
		write: (chunk: string) => { output += chunk; },
		end: () => {},
		output: () => output,
	};
}

function response(socket: ReturnType<typeof fakeSocket>) {
	return JSON.parse(socket.output().trim());
}

test("protected deletion routes only Deny and Allow once and persists no broad exemption", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	let presentedOptions: string[] = [];
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: {
				notify: () => {},
				select: async (_title: string, options: string[]) => {
					presentedOptions = options;
					return "Allow once";
				},
			},
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, request());
	assert.deepEqual(presentedOptions, ["Allow once", "Deny (keep blocked)"]);
	assert.equal(response(socket).decision, "allow_once");
	assert.deepEqual(readExemptionsFile(exemptionsFile), []);
});

test('withheld protected shell action cannot create a broad grant',async()=>{
 const req=bind(request({category:'read_only'}),{command:'echo password=private-body > .github/file'});
 const messages:string[]=[],logs:unknown[]=[];
 const router=createAccessApprovalRouter({getContext:()=>({hasUI:true,ui:{notify:t=>messages.push(t),async select(t,opts){messages.push(t);assert.deepEqual(opts,['Allow once','Deny (keep blocked)']);return 'Allow for all agents (this session)';}}}),getExemptionsFile:()=>null,appendLog:e=>logs.push(e),now:()=>new Date().toISOString()});
 const sock=fakeSocket();await router.handle(sock,req);
 assert.equal(response(sock).decision,'deny');assert.ok(messages.some(t=>t.includes('Target withheld')));assert.doesNotMatch(JSON.stringify([messages,logs]),/private-body/);
});

test("missing UI denies protected deletion fail-closed", async () => {
	const router = createAccessApprovalRouter({
		getContext: () => null,
		getExemptionsFile: () => undefined,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, request());
	assert.equal(response(socket).decision, "deny");
});

test("approval pending across a session reset is denied and never persisted", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	let answer!: (choice: string) => void;
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: {
				notify: () => {},
				select: () => new Promise((resolve) => { answer = resolve; }),
			},
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	const handling = router.handle(socket, request({ category: "zero_access", pattern: ".env" }));
	await new Promise((resolve) => setImmediate(resolve));
	router.reset();
	answer("Allow for all agents (this session)");
	await handling;
	assert.equal(response(socket).decision, "deny");
	assert.deepEqual(readExemptionsFile(exemptionsFile), []);
});

test("non-delete path approval can remain agent-scoped and is persisted", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: { notify: () => {}, select: async () => "Allow for builder (this session)" },
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, bind(request({
		tool: "read",
		rule: "Access to zero-access path restricted: .env",
		pattern: ".env",
		category: "zero_access",
		invocation: '{"path":".env"}',
	}),{path:'.env'}));
	assert.equal(response(socket).decision, "allow_agent");
	assert.deepEqual(readExemptionsFile(exemptionsFile).map(({ pattern, agent }) => ({ pattern, agent })), [
		{ pattern: ".env", agent: "builder" },
	]);
});

test('disconnected requester cannot create a late session exemption', async () => {
 const exemptionsFile = join(mkdtempSync(join(tmpdir(), 'approval-disconnect-')), 'exemptions.json');
 const { EventEmitter } = await import('node:events');
 const socket = Object.assign(new EventEmitter(), fakeSocket());
 let answer!: (value: string) => void;
 let signal: AbortSignal | undefined;
 const router = createAccessApprovalRouter({
  getContext: () => ({hasUI:true,ui:{notify(){},select:(_title,_options,settings)=>{signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>exemptionsFile, appendLog(){}, now:()=>new Date().toISOString(),
 });
 const handling=router.handle(socket,request({category:'read_only',pattern:'/bin/'}));
 await new Promise(resolve=>setImmediate(resolve));
 socket.emit('close');
 answer('Allow for all agents (this session)');
 await handling;
 assert.equal(signal?.aborted,true);
 assert.deepEqual(readExemptionsFile(exemptionsFile),[]);
});
