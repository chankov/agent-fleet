import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDamageGuard,assessDamageCall} from './damage-guard-port.ts';
test('standalone guard has no inference and revoked registration cannot affect next call',async()=>{
 const event={toolName:'bash',toolCallId:'id',input:{command:'echo ok'}},ctx={cwd:'/repo'};
 assert.deepEqual(await assessDamageCall(event,ctx),{block:false});
 const revoke=registerDamageGuard({call:async()=>({block:true,reason:'held'})});
 assert.equal((await assessDamageCall(event,ctx)).block,true);revoke();assert.equal((await assessDamageCall(event,ctx)).block,false);
});
