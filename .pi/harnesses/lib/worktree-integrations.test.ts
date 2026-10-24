import {canonicalMkdtempSync as mkdtempSync} from '../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,withSessionRoots,sessionGitEnv,targetProject} from './workspace-context.ts';
import {defaultSettingsPaths,resolveStockAskUserModule} from '../ask-user-remote/index.ts';
import {loadConfig} from '../../extensions/pi-voice-stt/config.ts';
import {createContextContinuityBroker} from '../agent-hub/context-continuity-broker.ts';
import {contextChannelCall} from '../agent-hub/context-continuity-client.ts';
import {openContextOwner,revokeContextOwner} from '../agent-hub/context-continuity-owners.ts';
import {FleetSessionClient} from '../../agent-fleet/scripts/lib/fleet-codex-session.ts';
test('optional configuration stays in af; session discovery carries the selected physical target',async()=>{
 const root=mkdtempSync(join(tmpdir(),'af-integrations-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),saved=process.env.PI_STT_CONFIG;
 const put=(file:string,text:string)=>{mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,text);};
 try{
  mkdirSync(repo);execFileSync('git',['init',repo],{env:sessionGitEnv(),stdio:'pipe'});execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial'],{env:sessionGitEnv(),stdio:'pipe'});execFileSync('git',['-C',repo,'worktree','add','--detach',target],{env:sessionGitEnv(),stdio:'pipe'});
  put(join(af,'.ai/stt.json'),JSON.stringify({language:'workspace-language'}));put(join(target,'.ai/stt.json'),JSON.stringify({language:'poison-target'}));put(join(af,'.pi/harnesses/ask-user-remote/index.ts'),'// fixture');
  const stock=join(af,'.pi/npm/node_modules/pi-ask-user/index.js');put(stock,'// Never executed');put(join(target,'.pi/npm/node_modules/pi-ask-user/index.js'),'throw Error("poison target")');
  delete process.env.PI_STT_CONFIG;const roots=resolveSessionRoots(af,{worktree:target});
  await withSessionRoots(roots,async()=>{
   assert.equal(defaultSettingsPaths()[0],join(af,'.pi/settings.json'));
   assert.equal(resolveStockAskUserModule({cwd:target,moduleUrl:pathToFileURL(join(af,'.pi/harnesses/ask-user-remote/index.ts')).href,homeDir:join(root,'no-home')}),pathToFileURL(stock).href);
   assert.equal(loadConfig().config.language,'workspace-language');assert.equal(loadConfig().source,join(af,'.ai/stt.json'));
   const project=targetProject('same',roots),now=Date.now();
   const client=new FleetSessionClient({stateDir:join(root,'client'),now:()=>now,readRegistry:requested=>requested===project?[{name:'same',project,session_id:'target-session',started_at:new Date(now).toISOString(),heartbeat_at:new Date(now).toISOString(),cwd:target,targetId:roots.targetId} as any]:[]});
   assert.equal(client.sessions(project).sessions[0].targetId,roots.targetId);assert.equal(client.sessions(project).sessions[0].cwd,target);assert.equal(client.sessions('same').sessions.length,0);
   const broker=await createContextContinuityBroker(),owner=openContextOwner('target-owner');
   try{const assignment=broker.assignment(owner);assert.equal(assignment.targetId,roots.targetId);assert.equal((await contextChannelCall(assignment,'context_status',{...owner.status})).status,'ok');
    const other=resolveSessionRoots(af,{worktree:repo});assert.throws(()=>{(owner as any).sessionRoots=other;});
    await withSessionRoots(other,async()=>{assert.equal((await contextChannelCall(assignment,'context_status',{...owner.status})).status,'unavailable');assert.equal((await contextChannelCall({...assignment,targetId:other.targetId},'context_status',{...owner.status})).status,'denied');});
   }finally{revokeContextOwner(owner.attempt);await broker.close();}
  });
 }finally{if(saved===undefined)delete process.env.PI_STT_CONFIG;else process.env.PI_STT_CONFIG=saved;rmSync(root,{recursive:true,force:true});}
});
