import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionChannel } from './questions.ts';
import { raceAskUser } from './race-core.js';

const owner = {project:'af', peer:'hub', sessionId:'one', startedAt:'2026-09-08T10:00:00Z'};
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
	let current = owner;
	const channel = new QuestionChannel(() => current);
	channel.enabled = true;
	return {channel, replace: () => { current = {...owner,sessionId:'two'}; }};
}
function ask(channel: QuestionChannel, flags = {}) {
	const q = channel.open('tool-one', {question:'Language?', context:'Report language', options:['BG','EN'], ...flags})!;
	let local!: (value: unknown) => void;
	const result = raceAskUser({runLocal: () => new Promise(resolve => { local = resolve; }),
		registerAnswer: q.registerAnswer, onSettled:q.onSettled});
	return {q,result,local: (value: unknown) => local(value)};
}
test('pending questions expose exact identity and flags; an invalid choice cannot win',async()=>{
	const {channel}=setup(); const a=ask(channel,{allowFreeform:false}); await tick();
	const listed=channel.list(owner);
	assert.equal(listed.questions[0].toolCallId,'tool-one');
	assert.equal(listed.questions[0].allowFreeform,false);
	assert.deepEqual(listed.questions[0].owner,owner);
	assert.equal(channel.submit(owner,a.q.id,'bad',{kind:'selection',selections:['FR']}).status,'invalid');
	assert.equal(channel.list(owner).questions.length,1);
	assert.equal(channel.submit(owner,a.q.id,'ok',{kind:'selection',selections:['BG']}).status,'accepted');
	const result=await a.result;
	assert.deepEqual(result.details.response,{kind:'selection',selections:['BG']});
	assert.equal(channel.submit(owner,a.q.id,'ok',{kind:'selection',selections:['BG']}).status,'accepted');
	assert.equal(channel.submit(owner,a.q.id,'ok',{kind:'selection',selections:['EN']}).status,'conflict');
	assert.equal(channel.submit(owner,a.q.id,'late',{kind:'selection',selections:['EN']}).status,'late');
});
test('local-first, reset and replaced owners refuse addressed answers',async()=>{
	const {channel,replace}=setup(); const a=ask(channel); await tick();
	a.local({details:{response:{kind:'freeform',text:'local'},cancelled:false}}); await a.result;
	assert.equal(channel.submit(owner,a.q.id,'late',{kind:'freeform',text:'phone'}).status,'late');
	const b=ask(channel); await tick(); channel.reset();
	assert.equal(channel.submit(owner,b.q.id,'reset',{kind:'freeform',text:'phone'}).status,'expired');
	replace(); assert.equal(channel.list(owner).status,'stale');
	b.local({details:{cancelled:true}}); await b.result;
});
test('concurrent questions have independent IDs; cancellation returns the stock result',async()=>{
	const {channel}=setup(); const a=ask(channel); const b=ask(channel,{allowMultiple:true,allowComment:true}); await tick();
	assert.notEqual(a.q.id,b.q.id);
	assert.equal(channel.submit(owner,a.q.id,'cancel',null).status,'accepted');
	assert.equal((await a.result).details.cancelled,true);
	assert.equal(channel.list(owner).questions.length,1);
	assert.equal(channel.submit(owner,b.q.id,'multi',{kind:'selection',selections:['BG','EN'],comment:'both'}).status,'accepted');
	assert.equal((await b.result).details.response.comment,'both');
});
test('freeform, multiple choice and comment flags are enforced before arbitration',async()=>{
	const {channel}=setup(); const a=ask(channel,{allowFreeform:false}); await tick();
	for(const [id,value] of Object.entries({free:{kind:'freeform',text:'x'},multi:{kind:'selection',selections:['BG','EN']},comment:{kind:'selection',selections:['BG'],comment:'x'}})) {
		assert.equal(channel.submit(owner,a.q.id,id,value).status,'invalid');
	}
	channel.submit(owner,a.q.id,'cancel',null); await a.result;
});

test('reusing a request ID for another question is a conflict',async()=>{
	const {channel}=setup();const a=ask(channel);const b=ask(channel);await tick();
	channel.submit(owner,a.q.id,'same',null);await a.result;
	assert.equal(channel.submit(owner,b.q.id,'same',null).status,'conflict');
	channel.submit(owner,b.q.id,'other',null);await b.result;
});

test('bounded question pages preserve all pending questions and report terminal receipt gaps',async()=>{
	const {channel}=setup();const active=Array.from({length:5},()=>ask(channel,{context:'x'.repeat(12000)}));await tick();
	const first=channel.list(owner);assert.ok(first.partial);assert.ok(first.nextCursor);
	const ids=new Set(first.questions.map(q=>q.id));let cursor=first.nextCursor;
	while(cursor){const page=channel.list(owner,cursor);page.questions.forEach(q=>ids.add(q.id));cursor=page.nextCursor;}
	assert.equal(ids.size,5);
	for(const a of active){channel.submit(owner,a.q.id,a.q.id,null);await a.result;}
});

test('capacity limits report a gap instead of claiming a complete pending list',()=>{
	const {channel}=setup();
	for(let i=0;i<65;i++)channel.open(String(i),{question:'Short question'});
	assert.equal(channel.list(owner).questions.length,64);
	assert.equal(channel.list(owner).partial,true);
});
