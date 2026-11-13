import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {codexNotificationSurface,codexNotificationSurfaceId,codexNotificationPolicy,codexNotificationBootstrapSurface,codexNotificationBootstrapSurfaceId,codexNotificationBootstrapPolicy} from './codex-notification-profile.ts';
import {assessCodexVersion} from './codex-compat.ts';
import {projectSchema,fingerprint,compareProjection,ContractProjectionError} from './codex-contract.ts';
import {assessQueueCompatibility} from './fleet-notification-validation.ts';
import {captureNotificationProfile,captureNotificationBootstrapProfile,notificationProfileSources} from '../../agent-fleet/scripts/fixtures/codex-notification-contracts/capture-profile.ts';
const fixture = JSON.parse(readFileSync(new URL('../../agent-fleet/scripts/fixtures/codex-notification-contracts/notification-profile-0.167.json',import.meta.url),'utf8'));
const original = JSON.parse(readFileSync(new URL('../../agent-fleet/scripts/fixtures/codex-notification-contracts/0.167-shared.json',import.meta.url),'utf8'));
const bootstrap = JSON.parse(readFileSync(new URL('../../agent-fleet/scripts/fixtures/codex-notification-contracts/bootstrap-profile-0.167.json',import.meta.url),'utf8'));
const docs = ():Record<string,any> => structuredClone(fixture.referenceDocuments);
const surface = codexNotificationSurface();
const known = projectSchema(docs(),surface);
const inputText = (documents:Record<string,any>,file='ClientRequest.json') => documents[file].definitions.UserInput.oneOf.find((branch:any)=>branch.properties.type.enum[0]==='text');

test('current queue/observer footprint covers twelve roots including both initializes and envelopes',()=>{
 assert.equal(fixture.qualification,'not_qualified');assert.equal(fixture.surfaceId,codexNotificationSurfaceId);
 assert.equal(Object.keys(known.roots).length,12);assert.deepEqual(known,fixture.projection);assert.equal(fingerprint(known),fixture.fingerprint);
 assert.equal(fixture.fingerprint,'aac9af961f496998b8cccd4f1eeecd2a40985733011073c5b6d589815adafb99');
 assert.equal(Object.keys(fixture.sourceHashes).length,14);
 for(const [file,hash] of Object.entries(original.sourceHashes))assert.equal(fixture.sourceHashes[file],hash);
 assert.ok(Object.keys(surface).some(key=>key.endsWith('initialized/request')));
 assert.ok(Object.keys(surface).some(key=>key.endsWith('jsonrpc/error')));
 assert.ok(!Object.keys(surface).some(key=>/loaded\/list|ServerNotification|transcript/.test(key)));
 for(const name of ['queue','observer'])assert.equal(surface[`${codexNotificationSurfaceId}/initialize/${name}/request`].shape.fields!.params.fields!.capabilities.fields!.experimentalApi.literal,name==='queue');
});

test('unused fields, unused input variants and empty-array element internals cannot change used footprint',()=>{
 const documents=docs();documents['ClientRequest.json'].definitions.TextElement.required.push('unusedFuture');
 documents['ClientRequest.json'].definitions.TextElement.properties.unusedFuture={type:'string'};
 documents['v1/InitializeResponse.json'].properties.future={type:'boolean'};
 documents['ClientNotification.json'].oneOf.push({type:'object',properties:{method:{type:'string',enum:['futureUnusedNotification']}}});
 documents['v2/ThreadQueueListResponse.json'].definitions.UserInput.oneOf.push({type:'object',properties:{type:{type:'string',enum:['futureUnusedInput']},future:{type:'object'}}});
 assert.deepEqual(compareProjection(known,projectSchema(documents,surface)),{compatible:true,reasons:[]});
 assert.equal(fingerprint(projectSchema(documents,surface)),fixture.fingerprint);
});

test('every envelope and caller family contributes constraints to compatibility',()=>{
 const changes:Array<(documents:Record<string,any>)=>void>=[
  d=>{d['JSONRPCResponse.json'].required=['id'];},
  d=>{d['JSONRPCError.json'].definitions.RequestId.anyOf.push({type:'boolean'});},
  d=>{d['v1/InitializeResponse.json'].properties.userAgent.type='integer';},
  d=>{d['ClientRequest.json'].definitions.InitializeCapabilities.properties.experimentalApi.enum=[true];},
  d=>{inputText(d).properties.text_elements.minItems=1;},
  d=>{inputText(d,'v2/ThreadQueueAddResponse.json').properties.text.type='integer';},
  d=>{d['ClientNotification.json'].oneOf[0].properties.params={type:'integer'};},
 ];
 for(const change of changes){const documents=docs();change(documents);assert.throws(()=>projectSchema(documents,surface),ContractProjectionError);}
 const d=docs();d['ClientRequest.json'].definitions.ThreadQueueListParams.properties.limit.maximum=99;
 assert.deepEqual(compareProjection(known,projectSchema(d,surface)),{compatible:false,reasons:['used_contract_changed']});
});

test('trusted reference is unqualified and structural preflight never grants runtime readiness',()=>{
 const context={daemonVersion:'0.167.1',desktopVersion:'0.167.0-alpha.3.2',socketEpoch:'synthetic:profile-epoch'};
 const policy=codexNotificationPolicy(docs());
 const evidence=(documents:Record<string,any>)=>({...context,contract:{state:'available',...context,documents}});
 const checked=assessQueueCompatibility(evidence(docs()),policy);
 assert.equal(checked.level,'contract_checked');assert.equal(checked.activation,'not_performed');assert.equal('ready' in checked,false);
 if(checked.level!=='contract_checked')assert.fail('must remain unqualified');else assert.equal(checked.requiresProbe,true);
 const changed=docs();changed['ClientNotification.json'].oneOf[0].properties.params={type:'integer'};
 assert.equal(assessQueueCompatibility(evidence(changed),policy).level,'blocked');
});

// This recreates SYNTHETIC source JSON for negative capture tests, NOT original
// measured bodies. Its byte hashes must not be confused with fixture provenance.
const syntheticSources=():Record<string,Uint8Array>=>Object.fromEntries(notificationProfileSources.map(file=>[file,Buffer.from(JSON.stringify(file==='ServerNotification.json'?{oneOf:original.fragments[file]['/oneOf'].map((name:string)=>({properties:{method:{enum:[name]}}}))}:fixture.referenceDocuments[file]))]));
test('offline capture is bounded, strict UTF8, detached and never qualifies synthetic bytes',()=>{
 const sources=syntheticSources(),capture=captureNotificationProfile(sources);
 assert.equal(capture.qualification,'not_qualified');assert.equal(capture.fingerprint,fixture.fingerprint);
 assert.notDeepEqual(capture.sourceHashes,fixture.sourceHashes);
 sources['JSONRPCResponse.json'].fill(0);assert.equal(fingerprint(capture.projection),fixture.fingerprint);
 const missing=syntheticSources();delete missing['JSONRPCResponse.json'];assert.throws(()=>captureNotificationProfile(missing));
 const invalid=syntheticSources();invalid['JSONRPCResponse.json']=Uint8Array.from([0xc3,0x28]);assert.throws(()=>captureNotificationProfile(invalid));
 const tooLarge=syntheticSources();tooLarge['JSONRPCResponse.json']=new Uint8Array(16*1024*1024+1);assert.throws(()=>captureNotificationProfile(tooLarge));
 const bom=syntheticSources();bom['JSONRPCResponse.json']=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(bom['JSONRPCResponse.json'])]);assert.equal(captureNotificationProfile(bom).fingerprint,fixture.fingerprint);
});

test('surface factories return detached graphs with stable identity and no policy authority',()=>{
 const a=codexNotificationSurface(),b=codexNotificationSurface();
 a[`${codexNotificationSurfaceId}/initialized/request`].shape.fields!.params={type:'string'};
 assert.deepEqual(b,codexNotificationSurface());assert.notDeepEqual(a,b);
 assert.equal('verifiedFingerprints' in b,false);assert.equal('minimum' in b,false);
});

test('prospective bootstrap has a distinct identity/reference with only optional nullable metadata path added',()=>{
 const selected=codexNotificationBootstrapSurface(),projected=projectSchema(bootstrap.referenceDocuments,selected);
 assert.equal(bootstrap.surfaceId,codexNotificationBootstrapSurfaceId);assert.notEqual(bootstrap.surfaceId,fixture.surfaceId);assert.equal(bootstrap.qualification,'not_qualified');
 assert.deepEqual(projected,bootstrap.projection);assert.equal(fingerprint(projected),'cf611f03213d2306972768f8b00c6628ecba67cadc7e3de947eb3bb6764a06ff');
 assert.deepEqual(bootstrap.sourceHashes,fixture.sourceHashes);assert.equal(Object.keys(projected.roots).length,12);
 const thread=selected[`${codexNotificationBootstrapSurfaceId}/thread/read/response`].shape.fields!.thread;
 assert.deepEqual(thread.fields!.path,{type:['string','null']});assert.deepEqual(thread.optional,['path']);
 assert.ok(!bootstrap.referenceDocuments['v2/ThreadReadResponse.json'].definitions.Thread.required.includes('path'));
 const normalized=Object.fromEntries(Object.entries(selected).map(([name,root])=>[codexNotificationSurfaceId+name.slice(codexNotificationBootstrapSurfaceId.length),root]));
 delete normalized[`${codexNotificationSurfaceId}/thread/read/response`].shape.fields!.thread.fields!.path;
 delete normalized[`${codexNotificationSurfaceId}/thread/read/response`].shape.fields!.thread.optional;
 assert.deepEqual(normalized,surface);assert.equal(fingerprint(projectSchema(bootstrap.referenceDocuments,surface)),fixture.fingerprint);
});

test('bootstrap path is schema-checked even though a runtime value may be absent/null; no invented fallback',()=>{
 for(const replacement of [undefined,true,{}, {type:'integer'}, {type:'object',properties:{}}, {$ref:'#/missing'}]){
  const documents=structuredClone(bootstrap.referenceDocuments),properties=documents['v2/ThreadReadResponse.json'].definitions.Thread.properties;
  if(replacement===undefined)delete properties.path;else properties.path=replacement;
  assert.throws(()=>projectSchema(documents,codexNotificationBootstrapSurface()),ContractProjectionError);
 }
 const documents=structuredClone(bootstrap.referenceDocuments);documents['v2/ThreadReadResponse.json'].definitions.Thread.properties.path.maxLength=4096;
 assert.deepEqual(compareProjection(bootstrap.projection,projectSchema(documents,codexNotificationBootstrapSurface())),{compatible:false,reasons:['used_contract_changed']});
});

test('bootstrap capture preserves the complete metadata response and parent assertions without changing current v1',()=>{
 const sources=syntheticSources();sources['v2/ThreadReadResponse.json']=Buffer.from(JSON.stringify(bootstrap.referenceDocuments['v2/ThreadReadResponse.json']));
 const result=captureNotificationBootstrapProfile(sources);assert.equal(result.fingerprint,bootstrap.fingerprint);assert.equal(result.qualification,'not_qualified');assert.notDeepEqual(result.sourceHashes,bootstrap.sourceHashes);
 assert.deepEqual(result.referenceDocuments['v2/ThreadReadResponse.json'],bootstrap.referenceDocuments['v2/ThreadReadResponse.json']);
 const raw=JSON.parse(Buffer.from(sources['v2/ThreadReadResponse.json']).toString('utf8'));raw.definitions.Thread.minProperties=1;
 sources['v2/ThreadReadResponse.json']=Buffer.from(JSON.stringify(raw));const constrained=captureNotificationBootstrapProfile(sources);
 assert.equal(constrained.referenceDocuments['v2/ThreadReadResponse.json'].definitions.Thread.minProperties,1);assert.notEqual(constrained.fingerprint,bootstrap.fingerprint);
 assert.equal(captureNotificationProfile(sources).fingerprint,fixture.fingerprint);
 raw.definitions.Thread.unevaluatedProperties=false;sources['v2/ThreadReadResponse.json']=Buffer.from(JSON.stringify(raw));assert.throws(()=>captureNotificationBootstrapProfile(sources),ContractProjectionError);
 assert.throws(()=>captureNotificationBootstrapProfile(syntheticSources()),ContractProjectionError);
 const changing=syntheticSources(),first=Buffer.from(JSON.stringify(bootstrap.referenceDocuments['v2/ThreadReadResponse.json'])),second=Buffer.from(first.toString('utf8')+' ');let reads=0;
 Object.defineProperty(changing,'v2/ThreadReadResponse.json',{enumerable:true,get:()=>++reads===1?first:second});
 assert.throws(()=>captureNotificationBootstrapProfile(changing),/profile_source_changed/);
});

test('bootstrap factory is detached, has no qualified fingerprints and keeps approved floors with probe still required',()=>{
 const a=codexNotificationBootstrapPolicy(bootstrap.referenceDocuments),b=codexNotificationBootstrapPolicy(bootstrap.referenceDocuments);
 a.profile.surface[`${codexNotificationBootstrapSurfaceId}/initialized/request`].shape.fields!.params={type:'integer'};
 assert.deepEqual(b.profile.surface,codexNotificationBootstrapSurface());assert.deepEqual(b.profile.verifiedFingerprints,[]);
 assert.deepEqual(b.daemon,{minimum:'0.166.0',denylist:[]});assert.deepEqual(b.desktop,{minimum:'0.166.0-alpha.5.1',denylist:[]});
 const context={daemonVersion:'0.167.1',desktopVersion:'0.167.0-alpha.3.2',socketEpoch:'synthetic:bootstrap-profile'};
 const assessment=assessQueueCompatibility({...context,contract:{state:'available',...context,documents:structuredClone(bootstrap.referenceDocuments)}},b);
 assert.equal(assessment.level,'contract_checked');assert.equal(assessment.activation,'not_performed');if(assessment.level==='contract_checked')assert.equal(assessment.requiresProbe,true);else assert.fail('unqualified bootstrap reference');
 assert.equal('readCapability'in b,false);assert.equal('ready'in assessment,false);
});

test('human-approved production floors are strict, detached and never a qualified registry',()=>{
 const documents=docs(),a=codexNotificationPolicy(documents),b=codexNotificationPolicy(documents);
 assert.deepEqual(structuredClone(a.daemon),{minimum:'0.166.0',denylist:[]});
 assert.deepEqual(structuredClone(a.desktop),{minimum:'0.166.0-alpha.5.1',denylist:[]});
 assert.equal(assessCodexVersion('0.165.9',a.daemon).eligible,false);
 assert.equal(assessCodexVersion('0.166.0',a.daemon).eligible,true);
 assert.equal(assessCodexVersion('0.166.0-alpha.5.0',a.desktop).eligible,false);
 assert.equal(assessCodexVersion('0.166.0-alpha.5.1',a.desktop).eligible,true);
 a.desktop.denylist.push('0.167.0');assert.deepEqual(b.desktop.denylist,[]);
 assert.deepEqual(a.profile.verifiedFingerprints,[]);assert.equal('ready' in a,false);
 (a.profile.referenceDocuments as any)['JSONRPCResponse.json'].required=[];
 assert.deepEqual(b.profile.referenceDocuments,documents);
});
