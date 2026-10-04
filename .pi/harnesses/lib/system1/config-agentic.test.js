import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgenticConfig,AGENTIC_LIMITS} from './config-agentic.js';
import {normalizeSystem1Config} from './config-v2.js';
test('recommended changes usage preference without granting export consent or widening limits',()=>{
 const c=parseAgenticConfig({mode:'recommended'});
 assert.equal(c.mode,'recommended');assert.equal(c.remoteContextApproved,false);
 assert.deepEqual(c.include,[]);assert.equal(c.allowToolOutputs,false);assert.deepEqual(c.limits,AGENTIC_LIMITS);
 const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'recommended'}}};
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'off');
 root.consumers.agenticAsk.remoteContextApproved=true;
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'ready');
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.config.mode,'recommended');
});
test('agentic defaults never authorize export and bounds only decrease',()=>{
 const c=parseAgenticConfig({mode:'advisory'}); assert.equal(c.remoteContextApproved,false);assert.deepEqual(c.include,[]);assert.equal(c.allowToolOutputs,false);
 for(const [k,v] of Object.entries(AGENTIC_LIMITS)) {assert.throws(()=>parseAgenticConfig({mode:'advisory',limits:{[k]:v+1}}));assert.equal(parseAgenticConfig({mode:'advisory',limits:{[k]:1}}).limits[k],1);}
 for(const include of [['../x'],['/x'],['**'],['a\\b']]) assert.throws(()=>parseAgenticConfig({mode:'advisory',include}));
 assert.throws(()=>parseAgenticConfig({mode:'advisory',provider:'evil'}));
});
test('unified schema isolates consent',()=>{
 const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'advisory'}}};
 assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'off');
 root.consumers.agenticAsk.remoteContextApproved=true; assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'ready');
 root.consumers.agenticAsk.endpoint='evil'; assert.equal(normalizeSystem1Config(root).consumers.agenticAsk.status,'invalid');
 assert.equal(normalizeSystem1Config(undefined).consumers.agenticAsk.status,'off');
});
