import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleQuestionEnvelope, registerQuestionPeer } from '../.pi/harnesses/ask-user-remote/questions.ts';
import { installAskUserRemote } from '../.pi/harnesses/ask-user-remote/index.ts';

test('real Pi wrapper → coms → CLI supports addressed answers, cancellation, local-first and session reset without prompting a model',async t=>{
	const root=fs.mkdtempSync('/tmp/fcq-');
	const saved={coms:process.env.PI_COMS_DIR,socket:process.env.HERDR_SOCKET_PATH,pane:process.env.HERDR_PANE_ID};
	process.env.PI_COMS_DIR=root;process.env.HERDR_SOCKET_PATH=path.join(root,'missing.sock');process.env.HERDR_PANE_ID='';
	const {createComsPeer}=await import('../.pi/harnesses/lib/coms-core.ts');
	const {runClient}=await import('./fleet-codex-client.ts');
	const {exchange}=await import('./lib/fleet-codex-transport.ts');
	const locals=new Map<string,(value:unknown)=>void>();
	const handlers=new Map<string,()=>void>();
	let tool:any;
	const pi:any={getFlag:(flag:string)=>flag==='name'?'hub':flag==='project'?'question-test':undefined,
		getSessionName:()=>undefined,appendEntry:()=>{},sendMessage:()=>assert.fail('question operation must not enqueue a prompt'),
		registerTool:(value:unknown)=>{tool=value;},on:(event:string,fn:()=>void)=>handlers.set(event,fn)};
	const ctx:any={cwd:root,model:{id:'test'},hasUI:false,getContextUsage:()=>({percent:0}),sessionManager:{getBranch:()=>[]},ui:{notify:()=>{}}};
	const peer=createComsPeer({pi,getContext:()=>ctx,handleCustomEnvelope:handleQuestionEnvelope});
	registerQuestionPeer(()=>peer.ready&&peer.identity?{project:peer.identity.project,peer:peer.identity.name,sessionId:peer.identity.session_id,startedAt:peer.identity.started_at}:null);
	t.after(async()=>{
		await peer.shutdown(); fs.rmSync(root,{recursive:true,force:true});
		for(const [key,value] of [['PI_COMS_DIR',saved.coms],['HERDR_SOCKET_PATH',saved.socket],['HERDR_PANE_ID',saved.pane]]){
			if(value===undefined)delete process.env[key!];else process.env[key!]=value;
		}
	});
	installAskUserRemote(pi,{startRemote:()=>null,stockFactory:api=>api.registerTool({name:'ask_user',execute:(id:string,_params:unknown,signal:AbortSignal)=>new Promise(resolve=>{
		locals.set(id,resolve);signal.addEventListener('abort',()=>resolve({details:{cancelled:true,response:null}}),{once:true});
	})})});
	await peer.connect({ctx,defaultNamePrefix:'hub',defaultPurpose:'test'});
	peer.writeLiveRegistry();
	const env={...process.env,CODEX_THREAD_ID:'01a0812b-7d44-78a0-ae47-d9c64baff164'};
	const cli=(...args:string[])=>runClient([...args,'--state-dir',path.join(root,'client')],env) as Promise<any>;
	await cli('select','--project','question-test','--peer','hub');
	const ask=(id:string)=>tool.execute(id,{question:`Language ${id}?`,options:['BG','EN'],allowFreeform:false},undefined,undefined,ctx);
	const first=ask('first');const second=ask('second');await new Promise(resolve=>setImmediate(resolve));
	let report=(await cli('status')).questionState;assert.equal(report.questions.length,2);
	assert.equal(report.newQuestionIds.length,2);
	const synced=await cli('resync');assert.equal(synced.questionState.questions.length,2);assert.deepEqual(synced.questionState.newQuestionIds,[]);
	const q1=report.questions.find((q:any)=>q.toolCallId==='first');const q2=report.questions.find((q:any)=>q.toolCallId==='second');
	const description=await cli('describe');
	assert.equal(description.operations.find((o:any)=>o.name==='answer').availability.status,'available');
	assert.equal(description.operations.find((o:any)=>o.name==='send').availability.status,'unavailable');
	assert.equal((await cli('questions')).questions.length,2);
	const answerFile=path.join(root,'answer.json');fs.writeFileSync(answerFile,JSON.stringify({kind:'selection',selections:['BG']}),{mode:0o600});
	assert.equal((await cli('answer','--id','a1','--question',q1.id,'--answer-file',answerFile)).status,'accepted');
	assert.deepEqual((await first).details.response,{kind:'selection',selections:['BG']});
	assert.equal((await cli('answer','--id','a1','--question',q1.id,'--answer-file',answerFile)).status,'accepted');
	assert.equal((await cli('cancel-question','--id','c1','--question',q2.id)).status,'accepted');
	assert.equal((await second).details.cancelled,true);
	assert.equal((await cli('status')).questionState.questions.length,0);
	const third=ask('third');await new Promise(resolve=>setImmediate(resolve));report=await cli('questions');
	const q3=report.questions[0];locals.get('third')!({details:{response:{kind:'selection',selections:['EN']}}});await third;
	assert.equal((await cli('answer','--id','late','--question',q3.id,'--answer-file',answerFile)).status,'late');
	const fourth=ask('fourth');await new Promise(resolve=>setImmediate(resolve));report=await cli('questions');
	const q4=report.questions[0];handlers.get('session_start')!();
	assert.equal((await cli('cancel-question','--id','expired','--question',q4.id)).status,'expired');
	locals.get('fourth')!({details:{cancelled:true}});await fourth;
	const stale=await exchange(peer.identity!.endpoint,{type:'question_request',version:1,msg_id:'stale',sender_session:'test',sender_endpoint:'',
		owner:{...q1.owner,sessionId:'restarted'},operation:'cancel',questionId:q1.id});
	assert.equal(stale.status,'stale');
	assert.equal((await cli('questions')).questions.length,0);
	const race=ask('race');await new Promise(resolve=>setImmediate(resolve));
	const qr=(await cli('questions')).questions[0];
	const response=await Promise.all(['left','right'].map(id=>exchange(peer.identity!.endpoint,{type:'question_request',version:1,msg_id:id,
		sender_session:'test',sender_endpoint:'',owner:qr.owner,operation:'answer',questionId:qr.id,answer:{kind:'selection',selections:[id==='left'?'BG':'EN']}})));
	assert.deepEqual(response.map(r=>r.status).sort(),['accepted','late']);
	assert.ok(['BG','EN'].includes((await race).details.response.selections[0]));
	await peer.shutdown();
	const replacement=createComsPeer({pi,getContext:()=>ctx,handleCustomEnvelope:handleQuestionEnvelope});
	const unregisterReplacement=registerQuestionPeer(()=>replacement.ready&&replacement.identity?{project:replacement.identity.project,
		peer:replacement.identity.name,sessionId:replacement.identity.session_id,startedAt:replacement.identity.started_at}:null);
	try {
		await replacement.connect({ctx,defaultNamePrefix:'hub',defaultPurpose:'test'});replacement.writeLiveRegistry();
		assert.equal((await cli('status')).status,'stale');
		await assert.rejects(cli('cancel-question','--id','restart','--question',qr.id),/stale/);
		await cli('select','--project','question-test','--peer','hub');
		assert.equal((await cli('cancel-question','--id','old-question','--question',qr.id)).status,'stale');
	} finally {unregisterReplacement();await replacement.shutdown();}
	const legacy=createComsPeer({pi:{...pi,getFlag:(flag:string)=>flag==='name'?'legacy':flag==='project'?'question-test':undefined},getContext:()=>ctx});
	try {
		await legacy.connect({ctx,defaultNamePrefix:'legacy',defaultPurpose:'test'});legacy.writeLiveRegistry();
		await cli('select','--project','question-test','--peer','legacy');
		assert.equal((await cli('questions')).status,'unsupported');
		assert.equal((await cli('status')).questionState.status,'unsupported');
		assert.equal((await cli('describe')).operations.find((o:any)=>o.name==='answer').availability.status,'unsupported');
		assert.equal((await cli('cancel-question','--id','old-runtime','--question',q1.id)).status,'unsupported');
	} finally {await legacy.shutdown();}
});
