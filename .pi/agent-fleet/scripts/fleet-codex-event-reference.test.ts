import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeQuestionReference,decodeQuestionReference,withinFleetReferenceLimit,validOpaqueToolCallId,MAX_QUESTION_REFERENCE_LENGTH} from '../../harnesses/lib/fleet-question-reference.ts';
import {validToolCall} from './lib/fleet-codex-answer-transport.ts';
const encoded=(id:string)=>'fleet:question:v2/question/'+Buffer.from(id,'utf16le').toString('base64url');

test('shared validator preserves the native opaque-ID contract and old reference bytes',()=>{
 assert.equal(validToolCall,validOpaqueToolCallId);
 for(const id of ['tool','call_x-fc_y.1','A'.repeat(256)]){
  const reference='fleet:question/question/'+id;
  assert.equal(encodeQuestionReference('question',id),reference);
  assert.deepEqual(decodeQuestionReference(reference),{questionId:'question',toolCallId:id});
  // There is exactly one canonical address, not a second v2 alias for old IDs.
  assert.equal(decodeQuestionReference(encoded(id)),null);
 }
});
test('opaque separators, whitespace, Unicode and lone surrogates round-trip without normalization',()=>{
 for(const id of ['call_x|fc_y','call/x:y%2Fz','|/:%+','=',' leading and trailing ','\u2028','тест 🧪','\ud800','\udc00','a\ud800b\udc00','é','e\u0301']){
  assert.equal(validToolCall(id),true);
  const reference=encodeQuestionReference('question',id);
  assert.match(reference,/^fleet:question:v2\/question\/[-_A-Za-z0-9]+$/);
  assert.deepEqual(decodeQuestionReference(JSON.parse(JSON.stringify(reference))),{questionId:'question',toolCallId:id});
 }
 assert.notEqual(encodeQuestionReference('question','é'),encodeQuestionReference('question','e\u0301'));
});
test('maximum valid opaque IDs have a tight derived transport bound; no generic bound increase',()=>{
 const q='q'.repeat(96),id='\uffff'.repeat(256),reference=encodeQuestionReference(q,id);
 assert.equal(MAX_QUESTION_REFERENCE_LENGTH,798);assert.equal(reference.length,MAX_QUESTION_REFERENCE_LENGTH);
 assert.deepEqual(decodeQuestionReference(reference),{questionId:q,toolCallId:id});
 assert.equal(withinFleetReferenceLimit('question',reference),true);
 for(const kind of ['message','permission'])assert.equal(withinFleetReferenceLimit(kind,reference),false);
 for(const id of ['a'.repeat(257),'\uffff'.repeat(257),'🧪'.repeat(129)])assert.throws(()=>encodeQuestionReference(q,id),/invalid_question_reference/);
 assert.throws(()=>encodeQuestionReference('q'.repeat(97),'tool'),/invalid_question_reference/);
 assert.equal(decodeQuestionReference(reference+'A'),null);
 assert.equal(withinFleetReferenceLimit('question',reference+'A'),false);
 assert.equal(withinFleetReferenceLimit('message','a'.repeat(512)),true);
 assert.equal(withinFleetReferenceLimit('message','a'.repeat(513)),false);
});
test('all forbidden controls and malformed or empty native IDs remain rejected',()=>{
 for(const code of [...Array.from({length:32},(_,i)=>i),127]){
  const id='call'+String.fromCharCode(code)+'id';
  assert.equal(validToolCall(id),false);assert.throws(()=>encodeQuestionReference('question',id),/invalid_question_reference/);
  assert.equal(decodeQuestionReference(encoded(id)),null);
 }
 for(const value of ['',null,undefined,0,{},[]]){
  assert.equal(validToolCall(value),false);
  assert.throws(()=>encodeQuestionReference('question',value as string),/invalid_question_reference/);
 }
 for(const value of ['',null,undefined,0,{},[],'bad/id','bad|id','q'.repeat(97)])assert.throws(()=>encodeQuestionReference(value as string,'tool'),/invalid_question_reference/);
});
test('decoder rejects noncanonical base64, extra components, raw opaque IDs and overlong inputs',()=>{
 const reference=encoded('|');
 for(const value of [null,{},0,'',reference+'=',reference+'/',reference+'/extra',reference.replace('fAA','fAB'),reference.replace('fAA','fA'),reference.replace('fAA','+AA'),' '+reference,reference+' ',reference.replace('v2','V2'),'fleet:question/v2/question/tool','fleet:question/question/call|id',encoded('x'.repeat(257)),encoded('\u0000'), 'fleet:question:v2/question/'+Buffer.alloc(514,1).toString('base64url')])assert.equal(decodeQuestionReference(value),null);
 assert.deepEqual(decodeQuestionReference(reference),{questionId:'question',toolCallId:'|'});
});
test('identifier anchors cannot accept a trailing JS line terminator as a legacy reference',()=>{
 for(const suffix of ['\n','\r','\r\n','\u2028','\u2029']){
  assert.throws(()=>encodeQuestionReference('question'+suffix,'tool'),/invalid_question_reference/);
  assert.equal(decodeQuestionReference('fleet:question/question'+suffix+'/tool'),null);
  assert.equal(decodeQuestionReference('fleet:question/question/tool'+suffix),null);
  const id='tool'+suffix;
  if(validToolCall(id)){
   assert.match(encodeQuestionReference('question',id),/^fleet:question:v2\//);
   assert.deepEqual(decodeQuestionReference(encodeQuestionReference('question',id)),{questionId:'question',toolCallId:id});
  }
 }
});
test('deterministic opaque-ID fuzz retains every permitted UTF-16 code unit',()=>{
 let seed=123456;
 for(let n=0;n<128;n++){
  let id='';for(let i=0;i<=n*2;i++){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   const code=seed&65535;id+=String.fromCharCode(code<32||code===127?124:code);
  }
  assert.equal(validToolCall(id),true);
  assert.deepEqual(decodeQuestionReference(encodeQuestionReference('question',id)),{questionId:'question',toolCallId:id});
 }
});
