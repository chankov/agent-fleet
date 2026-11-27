import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgenticConfig,AGENTIC_LIMITS,GIT_TRACKED_INCLUDE} from './config-agentic.js';
import {normalizeSystem1Config} from './config-v2.js';
test('on and off are canonical; missing is off; legacy advisory and recommended read as on with consent, scope and limits untouched',()=>{
 for (const [mode,expected] of [[undefined,'off'],['off','off'],['on','on'],['advisory','on'],['recommended','on']]) {
  const parsed=parseAgenticConfig(mode===undefined?{}:{mode});
  assert.equal(parsed.mode,expected,String(mode));
  assert.equal(parsed.legacyMode,['advisory','recommended'].includes(mode)?mode:undefined,String(mode));
 }
 for (const consent of [true,false,undefined]) {
  const legacy=parseAgenticConfig({mode:'advisory',...(consent===undefined?{}:{remoteContextApproved:consent}),include:['docs'],allowToolOutputs:true,limits:{maxCallsPerSession:7}});
  assert.equal(legacy.remoteContextApproved,consent===true,'consent, including false or absent, is preserved');
  assert.deepEqual(legacy.include,['docs']);assert.equal(legacy.allowToolOutputs,true);assert.equal(legacy.limits.maxCallsPerSession,7);
 }
 assert.throws(()=>parseAgenticConfig({mode:'always'}),/Invalid agentic mode/);
 const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{remoteContextApproved:true},taskTriage:{mode:'advisory',remoteContextApproved:false}}};
 assert.equal(normalizeSystem1Config(document).consumers.agenticAsk.status,'off','a missing mode disables Ask System 1');
});
test('on does not grant export consent or widen limits',()=>{
 const c=parseAgenticConfig({mode:'recommended'});
 assert.equal(c.mode,'on');assert.equal(c.remoteContextApproved,false);
 assert.deepEqual(c.include,[]);assert.equal(c.allowToolOutputs,false);assert.deepEqual(c.limits,AGENTIC_LIMITS);
 const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'recommended'}}};
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'off');
 root.consumers.agenticAsk.remoteContextApproved=true;
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'ready');
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.config.mode,'on');
});
test('agentic defaults never authorize export and bounds only decrease',()=>{
 const c=parseAgenticConfig({mode:'advisory'}); assert.equal(c.remoteContextApproved,false);assert.deepEqual(c.include,[]);assert.equal(c.allowToolOutputs,false);
 for(const [k,v] of Object.entries(AGENTIC_LIMITS)) {assert.throws(()=>parseAgenticConfig({mode:'advisory',limits:{[k]:v+1}}));assert.equal(parseAgenticConfig({mode:'advisory',limits:{[k]:1}}).limits[k],1);}
 for(const include of [['../x'],['/x'],['**'],['a\\b']]) assert.throws(()=>parseAgenticConfig({mode:'advisory',include}));
 assert.throws(()=>parseAgenticConfig({mode:'advisory',provider:'evil'}));
});
test('git:tracked is an explicit agentic export selector, not implicit consent',()=>{
 const c=parseAgenticConfig({mode:'recommended',include:[GIT_TRACKED_INCLUDE]});
 assert.deepEqual(c.include,['git:tracked']);assert.equal(c.remoteContextApproved,false);
 for(const include of [['git:*'],['git:all'],['git:tracked/'],['.']])assert.throws(()=>parseAgenticConfig({mode:'advisory',include}));
 const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'recommended',remoteContextApproved:true,include:['git:tracked']}}};
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'ready');
});
test('unified schema isolates consent',()=>{
 const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'advisory'}}};
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'off');
 root.consumers.agenticAsk.remoteContextApproved=true; assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'ready');
 root.consumers.agenticAsk.endpoint='evil'; assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'invalid');
 assert.equal(normalizeSystem1Config(undefined).consumers.agenticAsk.status,'off');
});
