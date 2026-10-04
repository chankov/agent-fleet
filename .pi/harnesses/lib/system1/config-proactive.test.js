import test from 'node:test'; import assert from 'node:assert/strict';
import { parseProactiveConfig } from './config-proactive.js';
import { normalizeSystem1Config } from './config-v2.js';
test('legacy and section golden proactive projection',()=>{
 const section={mode:'advisory',remoteContext:'selected-excerpts',include:['src/**'],maxEvaluationsPerSession:15};
 const root={version:2,mode:'off',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{proactiveReview:section}};
 assert.deepEqual(normalizeSystem1Config(root).consumers.proactiveReview.config,parseProactiveConfig({version:1,...section}));
 for(const bad of [{...section,include:['../secret']},{...section,mode:'off'},{...section,localBindings:[{}]}]) assert.throws(()=>parseProactiveConfig({version:1,...bad}));
});
