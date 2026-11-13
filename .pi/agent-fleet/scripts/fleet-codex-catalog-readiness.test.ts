import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS,assessLoadedFleetCatalog,McpProtocol,type LocalCodexMcp} from './lib/fleet-codex-local-mcp.ts';
import {assessLoadedFleetCatalog as sharedCatalog,fleetCatalogProtocolVersions,notificationToolNames,notificationPreview,desktopQueuePin,targetKey,type NotificationConfig} from '../../harnesses/lib/fleet-notification-validation.ts';
const fresh={identity:'host_context_validated',nodeVersion:'25.2.1',protocolVersion:'2025-06-18',tools:TOOLS.map(t=>({name:t.name}))};
test('loaded 21 tools cannot masquerade as the required current subset; assessment never reloads or grants',()=>{
 const observed={...fresh,tools:fresh.tools.slice(0,21)};
 const result=assessLoadedFleetCatalog(observed);
 assert.equal(result.ready,false);assert.equal(result.loadedCount,21);assert.equal(result.sourceCount,TOOLS.length);
 assert.deepEqual(result.missing,notificationToolNames.filter(name=>!observed.tools.some(t=>t.name===name)));
 assert.equal(result.action,'operator_reload_required_not_performed');
 assert.equal(assessLoadedFleetCatalog(fresh).ready,true);
 assert.equal(assessLoadedFleetCatalog({...fresh,identity:'unknown'}).ready,false);
 assert.equal(assessLoadedFleetCatalog({...fresh,tools:[...fresh.tools,fresh.tools[0]]}).ready,false);
});

test('additional valid MCP names are compatible without becoming required or invoked',()=>{
 const tools=[...fresh.tools,{name:'fleet_future_tool_v2'},{name:'Fleet.More-2'}],observed={...fresh,tools};
 for(const assess of [assessLoadedFleetCatalog,sharedCatalog]){
  const result=assess(observed);assert.equal(result.ready,true);assert.equal(result.loadedCount,tools.length);
  assert.deepEqual(result.missing,[]);assert.deepEqual(result.unexpected,[]);assert.equal(result.action,'none');
 }
 assert.equal(assessLoadedFleetCatalog(observed).sourceCount,TOOLS.length);
 assert.ok(notificationToolNames.every(name=>TOOLS.some(t=>t.name===name)));
});

test('no additional name can replace any required current method',()=>{
 for(const required of notificationToolNames){
  const observed={...fresh,tools:[...fresh.tools.filter(t=>t.name!==required),{name:'fleet_future_replacement'}]};
  for(const assess of [assessLoadedFleetCatalog,sharedCatalog]){const result=assess(observed);assert.equal(result.ready,false);assert.ok(result.missing.includes(required));assert.equal(result.action,'operator_reload_required_not_performed');}
 }
});

test('identity and explicit offered-protocol allowlist are not relaxed for complete or extended catalogs',()=>{
 assert.deepEqual(fleetCatalogProtocolVersions,['2025-06-18']);assert.equal(Object.isFrozen(fleetCatalogProtocolVersions),true);
 for(const identity of [undefined,null,'unknown','model_claimed'])assert.equal(sharedCatalog({...fresh,identity}).ready,false);
 for(const protocolVersion of [undefined,null,'2025-11-25','2025-03-26','2024-11-05','2099-01-01','2025-06-18\n'])assert.equal(sharedCatalog({...fresh,protocolVersion}).ready,false);
 const inherited=Object.assign(Object.create({identity:fresh.identity,protocolVersion:fresh.protocolVersion}),{tools:fresh.tools});
 assert.equal(sharedCatalog(inherited).ready,false);
});

test('MCP name alphabet/128 limit allow additions but reject controls, whitespace, Unicode and wildcard names',()=>{
 for(const name of ['A','fleet_v2','Fleet.Read-2','..','x'.repeat(128)])assert.equal(sharedCatalog({...fresh,tools:[...fresh.tools,{name}]}).ready,true);
 for(const name of ['', 'x'.repeat(129),'space name','comma,name','path/name','wild*','name\n','name\r','name\u0000','name\u007f','工具']){
  const result=sharedCatalog({...fresh,tools:[...fresh.tools,{name}]});assert.equal(result.ready,false);assert.deepEqual(result.unexpected,['unexpected_tool_entry']);
 }
});

test('invalid entries, duplicate names and sparse arrays never become accepted extras',()=>{
 for(const entry of [null,42,'tool',[],{},Object.assign([],{name:'array_name'}),Object.create({name:'inherited_name'})])assert.equal(sharedCatalog({...fresh,tools:[...fresh.tools,entry]}).ready,false);
 assert.equal(sharedCatalog({...fresh,tools:[...fresh.tools,{name:fresh.tools[0].name}]}).ready,false);
 const sparse:any[]=[...fresh.tools];sparse.length++;
 assert.equal(sharedCatalog({...fresh,tools:sparse}).ready,false);
 for(const observation of [null,[],{},'catalog',{...fresh,tools:{}}])assert.equal(sharedCatalog(observation).ready,false);
});

test('tool count is bounded before materializing even huge sparse/unreadable arrays',()=>{
 const tools=[...fresh.tools,...Array.from({length:128-fresh.tools.length},(_,i)=>({name:'extra_'+i}))];
 assert.equal(sharedCatalog({...fresh,tools}).ready,true);
 assert.equal(sharedCatalog({...fresh,tools:[...tools,{name:'one_over_limit'}]}).ready,false);
 const huge:any[]=[];huge.length=1_000_000_000;Object.defineProperty(huge,0,{get(){assert.fail('over-limit entries must not be read');}});
 const result=sharedCatalog({...fresh,tools:huge});assert.equal(result.ready,false);assert.equal(result.loadedCount,1_000_000_000);
});

test('explicit legacy 24/27 notification profiles tolerate unrelated additions but strict wrappers do not',()=>{
 for(const count of [24,27]){
  const observed={...fresh,tools:[...fresh.tools.slice(0,count),{name:'fleet_extension_v2'}],allowLegacy:true};
  const legacy=sharedCatalog(observed,true);assert.equal(legacy.ready,true);assert.equal(legacy.sourceCount,count);
  assert.equal(sharedCatalog(observed).ready,false);assert.equal(assessLoadedFleetCatalog(observed).ready,false);
  for(const flag of ['true',1,{}])assert.equal(sharedCatalog(observed,flag as unknown as boolean).ready,false);
 }
});

test('partial stronger family markers cannot downgrade to a legacy subset by manipulating count',()=>{
 const base=fresh.tools.slice(0,24),byName=(name:string)=>fresh.tools.find(t=>t.name===name)!;
 const partial=[...base,byName('fleet_connect_prepare'),{name:'extra_a'},{name:'extra_b'},{name:'extra_c'}];
 assert.equal(sharedCatalog({...fresh,tools:partial},true).ready,false);
 assert.equal(sharedCatalog({...fresh,tools:[...base,byName('fleet_response_read')]},true).ready,false);
 for(const name of ['fleet_connect_prepare','fleet_connect_commit','fleet_connection_status']){
  const result=sharedCatalog({...fresh,tools:[...fresh.tools.filter(t=>t.name!==name),{name:'extra'}]},true);
  assert.equal(result.ready,false);assert.ok(result.missing.includes(name));
 }
});

test('strict wrapper shares decisions while preserving actual sourceCount diagnostic',()=>{
 const observations=[fresh,{...fresh,tools:[...fresh.tools,{name:'extra'}]},{...fresh,tools:fresh.tools.slice(0,27)},{...fresh,identity:'unknown'},{...fresh,tools:[...fresh.tools,null]}];
 for(const observed of observations){const shared=sharedCatalog(observed),local=assessLoadedFleetCatalog(observed);assert.deepEqual({...local,sourceCount:shared.sourceCount},shared);assert.equal(local.sourceCount,TOOLS.length);}
});

test('allowlist follows the actual Fleet dispatcher offer, not every SDK/client revision',async()=>{
 const service={observeInitialization(){/* detached in-memory host observation only */},call(){assert.fail('initialize must not invoke a service/tool or discover policy');}} as unknown as LocalCodexMcp;
 for(const protocolVersion of ['2025-06-18','2025-11-25','2099-01-01']){
  const p=new McpProtocol(service),response=await p.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'fake',version:'1'}}}) as {result:{protocolVersion:string}};
  assert.equal(response.result.protocolVersion,'2025-06-18');assert.ok(fleetCatalogProtocolVersions.some(v=>v===response.result.protocolVersion));
 }
});

test('extended catalog does not bypass opt-in, exact queue tuple, mapping, owner or authority gates',()=>{
 const target={project:'fake',peer:'peer',sessionId:'epoch',startedAt:'2026-01-01T00:00:00Z'};
 const config:NotificationConfig={optedIn:true,stateRoot:'/tmp/fake-state',socketPath:'/tmp/fake-socket',messageBudgetMs:12000,loadedCatalog:{...fresh,tools:[...fresh.tools,{name:'extra'}]},approval:{binding:{id:'fake',hostInstance:'fake',threadId:'11111111-1111-4111-8111-111111111111',epoch:'fake',fleetOwner:targetKey(target)},target,authorityRevision:1,confirmedUntil:Date.now()+60000,transportOrigin:'user_input',mappingEvidence:'externally_confirmed_loaded_desktop',daemonVersion:desktopQueuePin.daemon,desktopVersion:desktopQueuePin.desktop,addSchema:desktopQueuePin.addSchema,responseSchema:desktopQueuePin.responseSchema}};
 const good=notificationPreview(config,target);assert.equal(good.ready,true);assert.equal(good.activation,'not_performed');assert.equal(good.requiresExplicitUserEnable,true);assert.equal(good.startsDaemon,false);assert.equal(good.grantsApprove,false);
 assert.equal(notificationPreview({...config,optedIn:false} as unknown as NotificationConfig,target).ready,false);
 assert.equal(notificationPreview(config,{...target,sessionId:'other'}).ready,false);
 for(const change of [{daemonVersion:'0.167.1'},{authorityRevision:0},{confirmedUntil:0},{transportOrigin:'model_claimed'},{mappingEvidence:'guessed'}])assert.equal(notificationPreview({...config,approval:{...config.approval,...change}} as unknown as NotificationConfig,target).ready,false);
});
