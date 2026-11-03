import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {createAccessApprovalRouter} from './access-approval.ts';
import type {AccessRequest} from '../lib/damage-control-shared.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function request(msg_id: string): AccessRequest {
 return {type:'access_request',msg_id,sender_session:'builder',sender_endpoint:'',hops:0,timestamp:new Date().toISOString(),agent:'builder',tool:'bash',rule:'protected delete',pattern:'.github/',category:'no_delete',invocation:'rm .github/a'};
}
function socket() {
 let output='';
 return Object.assign(new EventEmitter(), {write(chunk:string){output+=chunk;},end(){},output:()=>output});
}

test('disconnect of first coalesced requester does not cancel the live second requester', async () => {
 let answer!: (choice:string)=>void;
 let signal:AbortSignal|undefined;
 let asks=0;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){asks++;signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket(),second=socket();
 const a=router.handle(first,request('first'));
 await tick();
 const b=router.handle(second,request('second'));
 await tick();
 first.emit('close');
 const cancelled=signal?.aborted;
 answer('Allow once');
 await Promise.all([a,b]);
 assert.equal(cancelled,false);
 assert.equal(asks,1);
 assert.equal(first.output(),'');
 assert.equal(JSON.parse(second.output()).decision,'allow_once');
});

test('disconnect of all coalesced requesters aborts shared UI without caching a denial', async () => {
 let answer!: (choice:string)=>void;
 let signal:AbortSignal|undefined;
 let asks=0;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){asks++;signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket(),second=socket();
 const a=router.handle(first,request('first'));
 await tick();
 const b=router.handle(second,request('second'));
 await tick();
 first.emit('close');second.emit('close');
 assert.equal(signal?.aborted,true);
 answer('Deny (keep blocked)');
 await Promise.all([a,b]);
 const third=socket();
 const c=router.handle(third,request('third'));
 await tick();
 assert.equal(asks,2);
 answer('Allow once');await c;
 assert.equal(JSON.parse(third.output()).decision,'allow_once');
});
