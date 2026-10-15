import test from 'node:test';
import assert from 'node:assert/strict';
import {createApprovalWait} from './approval-wait.ts';
test('approval coordinator serializes dialogs and fences reset without overlapping old active wait',async()=>{
 const queue=createApprovalWait();let finish!:()=>void,active=0,max=0;
 const first=queue.run(async()=>{active++;max=Math.max(max,active);await new Promise<void>(r=>finish=r);active--;return 'old';});
 await new Promise(r=>setImmediate(r));queue.reset();
 const second=queue.run(async()=>{active++;max=Math.max(max,active);active--;return 'new';});
 await new Promise(r=>setImmediate(r));assert.equal(active,1);finish();
 assert.equal(await first,undefined);assert.equal(await second,'new');assert.equal(max,1);
});
