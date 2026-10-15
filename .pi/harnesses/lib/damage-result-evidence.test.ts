import test from 'node:test';
import assert from 'node:assert/strict';
import {captureDamageResult,originalDamageResult,damageCaptureAvailable,damageCaptureState} from './damage-result-evidence.ts';
import {damageResultView} from './damage-result-view.ts';
test('capture state distinguishes uncaptured, captured and sticky failure',()=>{
 const event={content:[{type:'text',text:'original'}]};
 assert.equal(damageCaptureState(event),'uncaptured');
 const original=captureDamageResult(event);
 assert.equal(damageCaptureState(event),'captured');
 event.content[0].text='decorated';
 assert.equal(captureDamageResult(event),original);
 assert.equal(original.content[0].text,'original');
 const failed:any={content:[],extra:()=>{}};
 captureDamageResult(failed);delete failed.extra;
 assert.equal(damageCaptureState(failed),'failed');
 captureDamageResult(failed);
 assert.equal(damageCaptureState(failed),'failed');
 assert.equal(originalDamageResult(failed),undefined);
});
for(const structured of [undefined,'prefix', {output:'source'}, {damageGuard:{retained:true}}])test(`original preserves all evidence and structured ${typeof structured}`,()=>{
 const event={content:[{type:'text',text:'source'},{type:'image',data:'fixture',mimeType:'image/png'}],details:{nested:[{retained:true}]},usage:{inputTokens:3},status:'blocked',exit_code:7,isError:true,...(structured===undefined?{}:{structuredContent:structured})};
 const expected=structuredClone(event),original=captureDamageResult(event);
 assert.deepEqual(original,expected);
 assert.notEqual(original.content,event.content);
 assert.notEqual(original.details,event.details);
 assert.notEqual(original.usage,event.usage);
 assert.ok(Object.isFrozen(original.content[1]));
 assert.ok(Object.isFrozen(original.details.nested[0]));
});
for(const extra of [new Date(),new Map(),new Set(),()=>{},Symbol('unsupported'),1n])test(`unsupported capture ${typeof extra} is an honest sticky gap`,()=>{
 const event={content:[],extra};captureDamageResult(event);
 assert.equal(damageCaptureState(event),'failed');
 assert.equal(originalDamageResult(event),undefined);
});
test('cyclic evidence fails before any consumer hash or adaptation',()=>{
 const event:any={content:[]};event.details=event;captureDamageResult(event);
 assert.equal(damageCaptureState(event),'failed');
 assert.equal(originalDamageResult(event),undefined);
});
test('non-cloneable extra refuses original provenance instead of aliasing nested evidence',()=>{
 const event={content:[{type:'text',text:'original'}],details:{nested:{value:'original'}},structuredContent:{nested:{value:'original'}},extra:()=>{}};
 captureDamageResult(event);event.content[0].text='mutated';event.details.nested.value='mutated';event.structuredContent.nested.value='mutated';assert.equal(damageCaptureAvailable(event),false);assert.equal(originalDamageResult(event),undefined);
});
test('supported original evidence is independently copied and recursively immutable',()=>{
 const event={content:[{type:'text',text:'original'}],details:{nested:{value:'original'}},structuredContent:{nested:{value:'original'}}},original=captureDamageResult(event);
 event.content[0].text='mutated';event.details.nested.value='mutated';assert.equal(original.content[0].text,'original');assert.equal(original.details.nested.value,'original');assert.throws(()=>{original.details.nested.value='bad';});assert.equal(originalDamageResult(event),original);
});
test('the structured-only view contains advice and preserves separately captured exact evidence',()=>{
 const event={content:[{type:'text',text:'exact source'}],structuredContent:'exact source'},original=captureDamageResult(event),view=damageResultView(event,'UNTRUSTED warning and coverage',{sourceTrusted:false});
 assert.match(view.structuredContent,/UNTRUSTED warning and coverage/);assert.equal(original.structuredContent,'exact source');assert.equal(view.content[0].text,'exact source');
 const value={output:'exact stdout',exit_code:0},objectView=damageResultView({content:[],structuredContent:value},'UNTRUSTED warning',{sourceTrusted:false});assert.deepEqual((objectView.structuredContent as any).originalStructuredContent,value);assert.equal((objectView.structuredContent as any).output,value.output);assert.match((objectView.structuredContent as any).damageGuard.text,/UNTRUSTED/);
});
