import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from './workspace-context.ts';
test('equal peer names and base projects communicate only within their own selected worktree',async()=>{
 const root=mkdtempSync(join(process.platform==='darwin'?'/tmp':tmpdir(),'afwt-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree');
 const keys=['AF_SESSION_ROOTS','AF_TARGET_BASE_PROJECT','AF_TARGET_EFFECTIVE_PROJECT','PI_COMS_DIR','HERDR_ENV'],saved=keys.map(key=>process.env[key]);const peers:any[]=[];
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  for(const key of keys)delete process.env[key];process.env.PI_COMS_DIR=join(root,'c');process.env.HERDR_ENV='0';
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  const {createComsPeer}=await import('./coms-core.ts');
  async function start(cwd:string,name:string){
   process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:cwd}));const delivered:any[]=[];
   const ctx:any={cwd,hasUI:false,model:{id:'same-model'},getContextUsage:()=>({percent:0}),sessionManager:{getBranch:()=>[]},ui:{notify(){},setWidget(){},setStatus(){}}};
   const pi:any={getFlag:(key:string)=>key==='project'?'same-project':key==='name'?name:undefined,getSessionName(){},appendEntry(){},sendMessage(message:any){delivered.push(message);}};
   const peer=createComsPeer({pi,getContext:()=>ctx});peers.push(peer);await peer.connect({ctx,defaultNamePrefix:'agent',defaultPurpose:'fixture'});return {peer,ctx,delivered};
  }
  const a=await start(repo,'hub'),ab=await start(repo,'builder'),b=await start(target,'hub'),bb=await start(target,'builder');
  assert.equal(a.peer.identity.name,'hub');assert.equal(b.peer.identity.name,'hub');assert.notEqual(a.peer.identity.project,b.peer.identity.project);assert.equal(a.peer.identity.baseProject,'same-project');assert.equal(b.peer.identity.cwd,target);
  const aList=await a.peer.list(),bList=await b.peer.list();assert.deepEqual(aList.agents.map((agent:any)=>agent.cwd),[repo]);assert.deepEqual(bList.agents.map((agent:any)=>agent.cwd),[target]);
  ab.peer.setTurnState('working');bb.peer.setTurnState('working');const sent=await a.peer.send({target:'builder',prompt:'ONLY A'});assert.equal(bb.delivered.length,0);ab.peer.setTurnState('idle');await ab.peer.settleTurn(ab.ctx);assert.equal(ab.delivered.length,1);assert.equal(ab.delivered[0].details.msg_id,sent.msg_id);assert.equal(bb.delivered.length,0);
  const sentB=await b.peer.send({target:'builder',prompt:'ONLY B'});bb.peer.setTurnState('idle');await bb.peer.settleTurn(bb.ctx);assert.equal(bb.delivered.length,1);assert.equal(bb.delivered[0].details.msg_id,sentB.msg_id);assert.equal(ab.delivered.length,1);
 }finally{await Promise.all(peers.map(peer=>peer.shutdown()));keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});rmSync(root,{recursive:true,force:true});}
});
