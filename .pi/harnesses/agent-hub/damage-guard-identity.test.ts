import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageIdentity} from './damage-guard-identity.ts';
test('D6 input revision persists without taskTriage and restores before same-task denial',()=>{
 const records:unknown[]=[],identity=createDamageIdentity(row=>records.push(row));
 identity.accept('task','user input');const revision=identity.revision('task');assert.equal(revision.length,64);
 const resumed=createDamageIdentity(()=>{});resumed.restore(records);assert.equal(resumed.revision('task'),revision);assert.equal(resumed.revision('next'),'');
 identity.accept('task','next input');assert.notEqual(identity.revision('task'),revision);
});
test('authoritative new task inherits latest accepted hash, never an inferred summary',()=>{
 const records:unknown[]=[],identity=createDamageIdentity(row=>records.push(row));identity.accept('old','accepted input');
 assert.equal(identity.bindTask('new'),identity.revision('old'));assert.equal(records.length,2);
 const resumed=createDamageIdentity(()=>{});resumed.restore(records);assert.equal(resumed.revision('new'),identity.revision('new'));
});
