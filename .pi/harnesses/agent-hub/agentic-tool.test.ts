import test from 'node:test';import assert from 'node:assert/strict';import {registerAskSystem1,ASK_SYSTEM1_PARAMETERS} from './tools/ask-system1.ts';import {createAgenticRuntime} from './agentic-runtime.ts';import {parseAgenticConfig} from '../lib/system1/config-agentic.js';import {resolveWorkModeTools} from './work-mode.ts';
test('typed registration is inert by default, direct invalid calls are refused',async()=>{
 let tool:any;const pi:any={registerTool:(t:any)=>tool=t};let runtime:any=null;registerAskSystem1(pi,{runtime:()=>runtime});assert.equal(tool.name,'ask_system1');assert.equal(ASK_SYSTEM1_PARAMETERS.properties.command,undefined);assert.equal(ASK_SYSTEM1_PARAMETERS.additionalProperties,false);
 const baselineTools=['bash','ask_system1'];assert.equal(resolveWorkModeTools({workMode:'operator',baselineTools,comsReady:false,herdrReady:false,askUserAvailable:false}).includes('ask_system1'),false);
 assert.equal((await tool.execute('call',{},new AbortController().signal)).details.reason,'consumer_off');
 let calls=0;runtime=createAgenticRuntime({config:parseAgenticConfig({mode:'advisory',remoteContextApproved:true}),sessionId:'s',context:()=> 't',persist(){},service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});
 const result=await tool.execute('call',{state:'x',questions:[{id:'q',type:'predicate',instructions:'Clear?'}],command:'false'},new AbortController().signal);assert.equal(result.details.reason,'invalid_input');assert.equal(calls,0);
});
