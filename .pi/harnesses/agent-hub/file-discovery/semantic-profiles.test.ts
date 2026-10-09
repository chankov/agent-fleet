import test from 'node:test';import assert from 'node:assert/strict';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
import {semanticQuestions,ORIENTATION_QUESTIONS,ORIENTATION_VERSION} from './semantic-profiles.ts';
const active=parseFileDiscoveryConfig({mode:'active',semanticReads:{mode:'active'}});
test('D8 orientation is deterministic, versioned, opt-in and does not invent proposition or risk questions',()=>{
 const off=parseFileDiscoveryConfig({mode:'active'});assert.equal(semanticQuestions(off).reason,'semantic_off');
 const pack=semanticQuestions(active);assert.equal(pack.version,ORIENTATION_VERSION);assert.deepEqual(pack.questions,ORIENTATION_QUESTIONS);
 assert.ok(pack.questions?.every(q=>q.type==='choice'&&'unknown' in q.options));assert.equal(active.remoteContextApproved,false);
});
test('D8 preserves explicit questions and the old cap, skipping orientation instead of truncating',()=>{
 const explicit=Array.from({length:14},(_,i)=>({id:'q'+i,type:'predicate' as const,instructions:'Explicit claim'}));
 const pack=semanticQuestions(active,explicit);assert.deepEqual(pack.questions,explicit);assert.equal(pack.reason,'question_slots');
 assert.equal(semanticQuestions(active,[...explicit,explicit[0]]).questions,undefined);
 assert.equal(semanticQuestions(active,[{id:ORIENTATION_QUESTIONS[0].id,type:'predicate',instructions:'collision'}]).reason,'reserved_id');
 assert.equal(semanticQuestions(active,[{id:'d9_role',type:'predicate',instructions:'collision'}]).questions,undefined);
 assert.equal(semanticQuestions(active,explicit.slice(0,11)).questions?.length,14);
});
