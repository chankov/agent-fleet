import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {confineNativeChild,linuxUserNamespaceSandboxAvailable} from '../write-isolation.ts';
import {nativeChildEnv,assertSafeSandboxStdio} from '../spawn.ts';
import {createDiscoveryRuntime} from './runtime.ts';
import {createDiscoveryOwners} from './owners.ts';
import {createDiscoveryBroker} from './broker.ts';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
function fixture(t:any){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'d9-sandbox-')));mkdirSync(join(root,'docs'));mkdirSync(join(root,'child-artifacts'));writeFileSync(join(root,'docs/a'),'safe code');
 t.after(()=>rmSync(root,{recursive:true,force:true}));return root;
}
test('unchanged production Linux and Darwin policies do not grant broker directory or entire parent session writes; unsupported backends fail closed',t=>{
 const root=fixture(t),privateDirectory=join(tmpdir(),'d9-private-not-a-write-grant');
 for(const platform of ['linux','darwin'] as const){
  const policy=confineNativeChild({enabled:true,platform,backendPath:platform==='linux'?'/usr/bin/bwrap':'/usr/bin/sandbox-exec',cwd:root,artifactPaths:[join(root,'child-artifacts')],command:process.execPath,args:['-e','void 0']});
  assert.equal(policy.applied,true,policy.reason);assert.equal(policy.permissionExpansion,false);assert.deepEqual(policy.writableDirectories,[join(root,'child-artifacts')]);assert.deepEqual(policy.writableFiles,[]);
  assert.ok(!JSON.stringify(policy.args).includes(privateDirectory));
  if(platform==='darwin'){assert.match(policy.seatbeltProfile!,/deny file-write\*/);assert.ok(!policy.seatbeltProfile!.includes(`(subpath "${root}")`));}
  else{assert.ok(policy.args!.includes('--ro-bind'));assert.ok(!policy.args!.includes('--unshare-net'));}
 }
 const unavailable=confineNativeChild({enabled:true,platform:'win32',cwd:root,artifactPaths:[join(root,'child-artifacts')]});assert.equal(unavailable.applied,false);assert.equal(unavailable.failClosed,true);
 assertSafeSandboxStdio(['pipe','pipe','pipe']);
 t.diagnostic('Darwin kernel transport is unproven on non-Darwin hosts; this is a production policy test, not a platform capability claim.');
});
test('actual available sandbox UDS smoke through network guard and production confinement, without socket/session write grants',async t=>{
 const root=fixture(t);
 if(process.platform!=='linux'&&process.platform!=='darwin'){t.skip('unsupported platform: no supported native sandbox backend');return;}
 if(process.platform==='linux'&&!linuxUserNamespaceSandboxAvailable()){
  const probe=spawnSync('bwrap',['--die-with-parent','--ro-bind','/','/','--','true'],{encoding:'utf8',timeout:5000});
  assert.notEqual(probe.status,0);
  t.diagnostic(`Actual bwrap namespace probe: exit=${probe.status}; error=${probe.error?.message??''}; stderr=${probe.stderr?.trim()??''}`);
  t.skip('Linux bwrap installed but kernel user-namespace sandbox unavailable; no unsandboxed substitute smoke');return;
 }
 let calls=0;const runtime=createDiscoveryRuntime({root,sessionId:'s',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),context:()=> 't',persist(){},service:{async evaluate(r){calls++;return {status:'ok',evaluation:{answers:[{questionId:'d9_relevance',type:'ordinal',value:0,levels:['unrelated','supporting','directly relevant','primary'],uncertainty:{provenance:'provider'}},{questionId:'d9_role',type:'choice',value:'implementation',uncertainty:{provenance:'provider'}}],metadata:{provider:'fake',requestedModel:'test',returnedModel:'test',questionSetVersion:r.questionSetVersion,latencyMs:0,attempts:1}}};}}});
 const owners=createDiscoveryOwners('s',()=> 't');const broker=await createDiscoveryBroker({root,runtime,owners});
 t.after(async()=>{runtime.dispose();await broker.close();});
 const lease=owners.register({taskId:'t',ownerId:'worker',attemptId:'smoke',cwd:root,task:'rounding',query:'docs',effectiveTools:['read','find'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'v1'});
 const assignment=owners.assignment(lease,broker.endpoint);
 const clientUrl=pathToFileURL(resolve('.pi/harnesses/agent-hub/file-discovery/broker-client.ts')).href;
 const script=`import {rankDiscovery} from ${JSON.stringify(clientUrl)};import {writeFileSync} from 'node:fs';const assignment=JSON.parse(process.env.D9_SANDBOX_TEST_ASSIGNMENT);const reply=await rankDiscovery(assignment,{paths:['docs/a'],discovery:{complete:true}});if(!reply.ok)throw Error(reply.error);let denied=0;for(const p of ['docs/blocked',${JSON.stringify(join(broker.directory,'forbidden'))}]){try{writeFileSync(p,'x');}catch{denied++;}}if(denied!==2)throw Error('write isolation relaxed');writeFileSync('child-artifacts/smoke','ok');console.log(JSON.stringify(reply));`;
 const env=nativeChildEnv({PATH:process.env.PATH,HOME:process.env.HOME,PI_OFFLINE:'1',TYPESAFE_API_KEY:'fake-must-be-stripped'},{D9_SANDBOX_TEST_ASSIGNMENT:JSON.stringify(assignment)});assert.equal(env.TYPESAFE_API_KEY,undefined);
 const launch=confineNativeChild({enabled:true,cwd:root,artifactPaths:[join(root,'child-artifacts')],command:process.execPath,args:['--import',resolve('bin/test/helpers/system1-no-network.js'),'--input-type=module','-e',script]});
 assert.equal(launch.applied,true,launch.reason);assert.ok(!launch.writableDirectories!.includes(broker.directory));assert.ok(!launch.writableDirectories!.includes(root));
 const child=spawn(launch.command!,launch.args!,{cwd:root,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end();
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const code=await new Promise<number|null>(r=>child.once('close',r));clearTimeout(timer);
 assert.equal(code,0,stderr);assert.equal(JSON.parse(stdout).result.rows[0].path,'docs/a');assert.equal(calls,1);assert.equal(existsSync(join(root,'child-artifacts/smoke')),true);assert.ok(!stdout.includes(assignment.capability));
 t.diagnostic(`Actual ${launch.mechanism} sandbox UDS smoke passed with existing grants only.`);
});
