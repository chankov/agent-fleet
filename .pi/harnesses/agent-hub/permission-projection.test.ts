import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {PermissionRelay} from './permission-relay.ts';import {handleObservationEnvelope} from '../lib/coms-observation.ts';
import {ObservationBridge} from '../../agent-fleet/scripts/lib/fleet-codex-observe.ts';
const owner={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'};
const input={command:'echo fixture'},base={taskId:'task',inputRevision:'rev',operation:'bash' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:'/tmp',owner:'hub',attempt:'attempt'};
test('all pending permissions are discoverable via bounded cursor pages, with independent permission observation',async t=>{
 const relay=new PermissionRelay(()=>owner);t.after(()=>relay.reset());for(let i=0;i<40;i++)assert.ok(relay.open({...base,actionId:'call-'+i},input,()=>true,Date.now()+60000));
 let cursor=null,ids:string[]=[];do{let reply:any;relay.handle({end(text:string){reply=JSON.parse(text);}} as any,{type:'permission_request',version:1,msg_id:'list',owner,operation:'list',payload:{limit:8,cursor},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});assert.equal(reply.status,'ok');assert.ok(reply.requests.length<=8);ids.push(...reply.requests.map((r:any)=>r.snapshot.id));cursor=reply.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,40);assert.equal(relay.summary().pendingCount,40);
 let raw:any;handleObservationEnvelope({end(text){raw=JSON.parse(text);}}, {type:'observation_request',version:1,msg_id:'observe',owner,operation:'snapshot'},{owner:()=>owner,session:()=>({getLeafId:()=>null,getEntry:()=>undefined}),questions:()=>({status:'available',partial:false,questions:[],resolved:[],nextCursor:null}),permissions:()=>relay.summary()});
 assert.equal(raw.permissionState.pendingCount,40);
 const bridge=new ObservationBridge({authorization:{checkAllowedReadTarget:async()=>({target:owner})},reader:async()=>({target:owner,...raw})});const observed=await bridge.observe({},{});
 assert.equal(observed.permissionState.pendingCount,40);assert.equal(observed.permissionState.source,'pi_permission_rpc');assert.equal(observed.permissionState.requests.length,32);assert.equal(observed.permissionState.partial,true);
});
