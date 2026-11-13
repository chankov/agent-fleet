import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('measured over-capacity context preserves COMS registration and native binding preview', async t => {
  const root=await mkdtemp(join(process.platform==='darwin'?'/tmp':tmpdir(),'afoc-'));
  const registry=join(root,'r'), policy=join(root,'p');
  const previous={PI_COMS_DIR:process.env.PI_COMS_DIR,HERDR_ENV:process.env.HERDR_ENV,AF_SESSION_ROOTS:process.env.AF_SESSION_ROOTS};
  let closePeer:(()=>Promise<void>)|undefined;
  t.after(async()=>{
    try { await closePeer?.(); }
    finally {
      for(const key of Object.keys(previous) as (keyof typeof previous)[]){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}
      await rm(root,{recursive:true,force:true});
    }
  });
  process.env.PI_COMS_DIR=registry;process.env.HERDR_ENV='0';delete process.env.AF_SESSION_ROOTS;
  // Import only after setting the disposable root: COMS caches it at module load.
  const {createComsPeer}=await import('../../harnesses/lib/coms-core.ts');
  const {LocalCodexMcp,McpProtocol}=await import('./lib/fleet-codex-local-mcp.ts');
  let percent=142;
  const pi={getFlag:(flag:string)=>flag==='name'?'overcontext-fixture':flag==='project'?'overcontext':undefined,getSessionName:()=>undefined,appendEntry:()=>{},sendMessage:()=>{throw Error('no prompt delivery allowed');}} as any;
  const ctx={cwd:root,model:{id:'fixture-model'},hasUI:false,getContextUsage:()=>({percent}),sessionManager:{getBranch:()=>[]},ui:{notify:()=>{},setWidget:()=>{},setStatus:()=>{}}} as any;
  const peer=createComsPeer({pi,getContext:()=>ctx});closePeer=()=>peer.shutdown();
  const identity=await peer.connect({ctx,defaultNamePrefix:'fixture',defaultPurpose:''});
  assert.ok(identity.endpoint.startsWith(registry+'/'));
  const target={project:identity.project,peer:identity.name,sessionId:identity.session_id,startedAt:identity.started_at};
  // This fixture tests registry/read binding preview, not the asynchronous bootstrap publisher.
  const service=new LocalCodexMcp({registryRoot:registry,policyRoot:policy,hostProfile:'fixture',principal:'fixture',bootstrapTransport:false}),protocol=new McpProtocol(service);
  await protocol.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
  await protocol.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  let id=1;
  const tool=async(name:string,args:unknown)=>{
    const reply=await protocol.handle({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{threadId:'11111111-1111-4111-8111-111111111111'}}}) as any;
    assert.equal(reply.error,undefined);
    return {isError:reply.result.isError,value:JSON.parse(reply.result.content[0].text)};
  };
  await t.test('first published registration is native-readable before any heartbeat tick',async()=>{
    const discovered=await tool('fleet_discover',{project:target.project,peer:target.peer});
    assert.equal(discovered.isError,false);
    assert.equal(discovered.value.partial,false,JSON.stringify(discovered.value.reasons));
    assert.deepEqual(discovered.value.candidates.map((c:any)=>c.target),[target]);
    const entry=JSON.parse(await readFile(identity.registryFile,'utf8'));
    assert.ok(Number.isFinite(Date.parse(entry.heartbeat_at)));
    assert.ok(Date.parse(entry.heartbeat_at)>=Date.parse(identity.started_at));
    assert.equal(entry.context_used_pct,142);
    assert.equal(entry.context_measurement,'measured');
  });
  for(const measured of [100,100.01,142,250])await t.test(`${measured}% remains metadata, not an admission limit`,async()=>{
    percent=measured;peer.writeLiveRegistry();
    const entry=JSON.parse(await readFile(identity.registryFile,'utf8'));
    assert.equal(entry.context_used_pct,Math.round(measured));assert.equal(entry.context_measurement,'measured');
    assert.equal(peer.ready,true);assert.ok((await stat(identity.endpoint)).isSocket());
    const selectors={project:target.project,peer:target.peer};
    const discovered=await tool('fleet_discover',selectors);
    assert.equal(discovered.isError,false);assert.equal(discovered.value.partial,false);
    assert.deepEqual(discovered.value.candidates.map((c:any)=>c.target),[target]);
    const preview=await tool('fleet_binding_prepare',{intent:'enroll_read',...selectors});
    assert.equal(preview.isError,false);assert.equal(preview.value.status,'prepared');assert.deepEqual(preview.value.target,target);
    assert.deepEqual(preview.value.storedRights,[]);
    const denied=await tool('fleet_check_read',selectors);
    assert.equal(denied.isError,true);assert.equal(denied.value.code,'STATE_MISSING');
    await assert.rejects(()=>stat(policy),(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT');
    await assert.rejects(()=>stat(policy+'.presence'),(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT');
  });
  await t.test('unavailable measurement cannot invalidate initial registration',async child=>{
    const unknownContext={...ctx,getContextUsage:()=>{throw Error('fixture measurement unavailable');}};
    const unknownPeer=createComsPeer({pi:{...pi,getFlag:(flag:string)=>flag==='name'?'unknown-usage':flag==='project'?identity.project:undefined},getContext:()=>unknownContext});
    child.after(()=>unknownPeer.shutdown());
    const registered=await unknownPeer.connect({ctx:unknownContext,defaultNamePrefix:'fixture',defaultPurpose:''});
    const entry=JSON.parse(await readFile(registered.registryFile,'utf8'));
    assert.equal(entry.context_used_pct,null);assert.equal(entry.context_measurement,'unknown');
    assert.ok(Number.isFinite(Date.parse(entry.heartbeat_at)));
    assert.ok(Date.parse(entry.heartbeat_at)>=Date.parse(registered.started_at));
    const discovered=await tool('fleet_discover',{project:registered.project,peer:registered.name});
    assert.equal(discovered.isError,false);assert.equal(discovered.value.partial,false);
    assert.equal(discovered.value.candidates[0].target.sessionId,registered.session_id);
  });
});
