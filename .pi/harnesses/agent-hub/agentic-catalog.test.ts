import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {configureAgenticHub,registerAgenticHub,agenticHubEnabled,agenticParentAllowed,resetAgenticHub} from './agentic-hub.ts';import {normalizeSystem1Config} from '../lib/system1/config-v2.js';import {resolveWorkModeTools} from './work-mode.ts';import {createWorkModePolicy} from './policy/work-mode.ts';
for(const mode of ['advisory','recommended']) test(`${mode}: approved parent catalog survives mode refresh, disabled/child cannot inherit`,async()=>{
 const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode,remoteContextApproved:true,allowToolOutputs:true}}};
 const root=mkdtempSync(join(tmpdir(),'ask-catalog-'));try{
 mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai/agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 const hooks:Record<string,Function[]>={};let tool:any;const entries:any[]=[];
 const pi:any={registerTool:(t:any)=>tool=t,on:(e:string,f:Function)=>(hooks[e]??=[]).push(f),appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})};registerAgenticHub(pi);
 const ctx:any={cwd:root,sessionManager:{getSessionId:()=> 's',getEntries:()=>entries}};
 configureAgenticHub(pi,{snapshot:normalizeSystem1Config(document),service:{evaluate:async()=>({status:'cancelled'})},ctx,sessionDir:root,taskId:()=> 'task'});assert.equal(agenticHubEnabled(pi),true);
 for(const workMode of ['operator','orchestrator'] as const) {const tools=resolveWorkModeTools({workMode,baselineTools:['bash','ask_system1'],comsReady:false,herdrReady:false,askUserAvailable:false,agenticAskEnabled:agenticHubEnabled(pi),capabilityPacks:['core']});assert.ok(tools.includes('ask_system1'));if(workMode==='orchestrator')assert.ok(!tools.includes('bash'));}
 const captured=hooks.tool_result[0]({toolName:'bash',toolCallId:'call',isError:false,content:[{type:'text',text:'diff'}]},ctx);assert.ok(captured.details.agenticEvidence.ref);
 const result=await tool.execute('ask',{evidenceRefs:[captured.details.agenticEvidence.ref],questions:[{id:'q',type:'predicate',instructions:'Risk?'}]},new AbortController().signal);assert.equal(result.details.status,'cancelled');assert.equal(JSON.stringify(result).includes('"text":"diff"'),false);
 let activeTools:string[]=[];
 const policy=createWorkModePolicy({getBaselineTools:()=>['bash','ask_system1'],getRosterSize:()=>1,getActiveTeamName:()=> 'default',getComsReady:()=>false,getHerdrReady:()=>false,getAskUserAvailable:()=>false,getAgenticAskEnabled:()=>agenticHubEnabled(pi),getIdentityLabel:()=>null,getTaskTier:()=> 'small',getPendingOperations:()=>[],getContextState:()=> 'normal',getActiveTools:()=>activeTools,setActiveTools:tools=>activeTools=tools,persist(){},replayDeferredInputs(){},watchdogArmed:()=>false});
 policy.applyWorkModeTools();assert.ok(activeTools.includes('ask_system1'));await policy.commit('orchestrator',{...ctx,hasUI:false,ui:{setStatus(){},notify(){}}});policy.refreshCapabilities();policy.applyWorkModeTools();assert.ok(activeTools.includes('ask_system1'));assert.ok(!activeTools.includes('bash'));
 const previousChild=process.env.AGENT_FLEET_AGENTIC_CHILD;
 try{process.env.AGENT_FLEET_AGENTIC_CHILD='1';assert.equal(agenticHubEnabled(pi),false);assert.equal((await tool.execute('ask',{state:'x',questions:[{id:'q',type:'predicate',instructions:'Clear?'}]},new AbortController().signal)).details.reason,'consumer_off');policy.applyWorkModeTools();assert.ok(!activeTools.includes('ask_system1'));}finally{if(previousChild===undefined)delete process.env.AGENT_FLEET_AGENTIC_CHILD;else process.env.AGENT_FLEET_AGENTIC_CHILD=previousChild;}
 assert.equal(agenticParentAllowed({AGENT_HUB_AGENT_ID:'worker'}),false);assert.equal(agenticParentAllowed({AGENT_FLEET_AGENTIC_CHILD:'1'}),false);
 resetAgenticHub(pi);assert.equal(agenticHubEnabled(pi),false);assert.equal((await tool.execute('ask',{},new AbortController().signal)).details.reason,'consumer_off');
 writeFileSync(join(root,'.ai/agent-fleet.json'),JSON.stringify({features:{system1:false}}));configureAgenticHub(pi,{snapshot:normalizeSystem1Config(document),ctx,sessionDir:root,taskId:()=> 'task'});assert.equal(agenticHubEnabled(pi),false);
 configureAgenticHub(pi,{snapshot:normalizeSystem1Config({...document,consumers:{}}),ctx,sessionDir:root,taskId:()=> 'task'});assert.equal(agenticHubEnabled(pi),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
