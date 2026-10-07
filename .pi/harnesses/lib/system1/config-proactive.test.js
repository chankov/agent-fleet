import test from 'node:test'; import assert from 'node:assert/strict';
import { parseProactiveConfig } from './config-proactive.js';
import { normalizeSystem1Config } from './config-v2.js';
test('external include requires both bounded syntax and explicit contextual authorization',()=>{
 const section={version:1,mode:'shadow',include:['../rin-docs'],remoteContext:'disabled'};
 const context={externalIncludeAllowed:path=>path==='../rin-docs'||path==='../rin-docs/docs/**'};
 assert.throws(()=>parseProactiveConfig(section));
 assert.deepEqual(parseProactiveConfig(section,context).include,['../rin-docs']);
 assert.deepEqual(parseProactiveConfig({...section,include:['../rin-docs/docs/**']},context).include,['../rin-docs/docs/**']);
 for(const path of ['../other','/tmp/docs','../rin-docs/../other','../rin-docs/.env','../rin-docs/secrets/a.md','../rin-docs/node_modules/**','../rin-docs/docs\\x','../rin-docs/**/../x']) {
  assert.throws(()=>parseProactiveConfig({...section,include:[path]},context));
 }
 for(const path of ['../rin-docs/.env','../rin-docs/key.pem','../rin-docs/sessions/log.md','../rin-docs/credentials.json','../rin-docs/id_rsa']) assert.throws(()=>parseProactiveConfig({...section,include:[path]},{externalIncludeAllowed:()=>true}));
 assert.throws(()=>parseProactiveConfig({...section,mode:'off'},context));
 const root={version:2,mode:'off',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{proactiveReview:{mode:'shadow',include:['../rin-docs']}}};
 assert.equal(normalizeSystem1Config(root).consumers.proactiveReview.status,'invalid');
 assert.equal(normalizeSystem1Config(root,context).consumers.proactiveReview.status,'ready');
 assert.equal(normalizeSystem1Config(root,context).status,'off');
});

test('legacy and section golden proactive projection',()=>{
 const section={mode:'advisory',remoteContext:'selected-excerpts',include:['src/**'],maxEvaluationsPerSession:15};
 const root={version:2,mode:'off',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{proactiveReview:section}};
 assert.deepEqual(normalizeSystem1Config(root).consumers.proactiveReview.config,parseProactiveConfig({version:1,...section}));
 for(const bad of [{...section,include:['../secret']},{...section,mode:'off'},{...section,localBindings:[{}]}]) assert.throws(()=>parseProactiveConfig({version:1,...bad}));
});
