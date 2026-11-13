import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQueueCompatibility,desktopQueuePin,matchesDesktopQueueTuple,type QueueCompatibilityAssessment} from './fleet-notification-validation.ts';
import {projectSchema,fingerprint,type UsedSurface} from './codex-contract.ts';

// Illustrative synthetic surface ONLY. Not a real Codex/Desktop qualification.
const surface:UsedSurface={'synthetic.request':{file:'synthetic.json',direction:'request',shape:{type:'object',fields:{message:{type:'string'}}}}};
const documents=():Record<string,any>=>({'synthetic.json':{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}});
const context={daemonVersion:'0.167.1',desktopVersion:'0.167.0-alpha.3.2',socketEpoch:'test:epoch:1'};
const evidence=(docs:unknown=documents()):Record<string,any>=>({...context,contract:{state:'available',...context,documents:docs}});
const hash=(docs:unknown=documents(),selection=surface)=>fingerprint(projectSchema(docs,selection));
const policy=(qualified=false):Record<string,any>=>({daemon:{minimum:'0.166.0',denylist:[]},desktop:{minimum:'0.166.0-alpha.0',denylist:[]},profile:{surface:structuredClone(surface),referenceDocuments:documents(),verifiedFingerprints:qualified?[hash()]:[]}});
const unavailable=(reason='schema_export_unavailable'):Record<string,any>=>({...context,contract:{state:'unavailable',...context,reason}});
function blocked(result:QueueCompatibilityAssessment,reason:string){
 assert.equal(result.level,'blocked');if(result.level==='blocked')assert.equal(result.reason,reason);
 assert.equal(result.activation,'not_performed');assert.equal('ready' in result,false);assert.equal('requiresProbe' in result,false);
}

test('qualified fingerprint is verified preflight only: no ready, probe execution or authority',()=>{
 const result=assessQueueCompatibility(evidence(),policy(true));
 assert.deepEqual(result,{level:'verified',fingerprint:hash(),context,requiresProbe:true,activation:'not_performed'});
 assert.equal('ready' in result,false);assert.equal('grantsApprove' in result,false);
});

test('structural reference is not qualification; new compatible fingerprint is contract_checked',()=>{
 const result=assessQueueCompatibility(evidence(),policy());
 assert.deepEqual(result,{level:'contract_checked',fingerprint:hash(),context,requiresProbe:true,activation:'not_performed'});
});

test('additive unused fields, unsupported unused payload and annotations do not change the used fingerprint',()=>{
 const d=documents();d['synthetic.json'].description='new unused schema release';
 d['synthetic.json'].properties.unusedAudio={oneOf:[{if:{type:'string'},then:{not:{}}}]};
 assert.equal(hash(d),hash());
 assert.equal(assessQueueCompatibility(evidence(d),policy(true)).level,'verified');
});

test('both roles apply strict minimum/denylist before any qualified fingerprint fast path',()=>{
 for(const role of ['daemon','desktop']){
  const e=evidence(),p=policy(true);e[role+'Version']='0.165.0';e.contract[role+'Version']='0.165.0';
  blocked(assessQueueCompatibility(e,p),role+'_below_minimum');
  e[role+'Version']='0.167.1+another-build';e.contract[role+'Version']=e[role+'Version'];p[role].denylist=['0.167.1+denied-build'];
  blocked(assessQueueCompatibility(e,p),role+'_denied_version');
  e[role+'Version']='codex-cli 0.167.1';blocked(assessQueueCompatibility(e,p),role+'_invalid_version');
 }
});

test('D6 unavailable export is visibly unverified and still requires a future probe',()=>{
 for(const reason of ['matching_binary_unavailable','schema_export_unavailable','schema_export_timeout']){
  const p=policy();delete p.profile;
  assert.deepEqual(assessQueueCompatibility(unavailable(reason),p),{level:'contract_unverified',reason,warning:'schema_not_verified',context,requiresProbe:true,activation:'not_performed'});
 }
 for(const reason of ['user_cancelled','binary_changed','projection_failed','unrecognized'])blocked(assessQueueCompatibility(unavailable(reason),policy()),'invalid_evidence');
});

test('available schema requires a complete configured profile, not a D6 fallback',()=>{
 const p=policy();delete p.profile;
 blocked(assessQueueCompatibility(evidence(),p),'profile_unavailable');
});

test('version/build/socket source tag changes block even with a qualified fingerprint or unavailable export',()=>{
 for(const e of [evidence(),unavailable()])for(const key of ['daemonVersion','desktopVersion','socketEpoch']){
  const changed=structuredClone(e);changed.contract[key]+='+changed';
  blocked(assessQueueCompatibility(changed,policy(true)),'measurement_changed');
 }
});

test('used breaking/unsupported schema cannot silently become contract_unverified',()=>{
 const missing=documents();delete missing['synthetic.json'].properties.message;
 blocked(assessQueueCompatibility(evidence(missing),policy()),'projection_used_field_missing');
 const required=documents();required['synthetic.json'].properties.extra={type:'string'};required['synthetic.json'].required.push('extra');
 blocked(assessQueueCompatibility(evidence(required),policy()),'projection_required_request_field_not_sent');
 const type=documents();type['synthetic.json'].properties.message.type='integer';
 blocked(assessQueueCompatibility(evidence(type),policy()),'projection_type_mismatch');
 const unsupported=documents();unsupported['synthetic.json'].properties.message.not={};
 blocked(assessQueueCompatibility(evidence(unsupported),policy()),'projection_unsupported_keyword');
 const bound=documents();bound['synthetic.json'].properties.message.maxLength=10;
 blocked(assessQueueCompatibility(evidence(bound),policy()),'used_contract_changed');
});

test('malformed policies, sparse/duplicate/oversized qualifications and invalid reference fail closed',()=>{
 const bad:unknown[]=[null,[],{},'policy'];
 const missing=policy();delete missing.daemon;bad.push(missing);
 const extra=policy();extra.probePassed=true;bad.push(extra);
 const noFloor=policy();delete noFloor.desktop.minimum;bad.push(noFloor);
 for(const hashes of [new Array(1),[hash(),hash()],['A'.repeat(64)],Array.from({length:129},(_,i)=>i.toString(16).padStart(64,'0'))]){
  const p=policy();p.profile.verifiedFingerprints=hashes;bad.push(p);
 }
 const invalidReference=policy(true);invalidReference.profile.referenceDocuments={};bad.push(invalidReference);
 const invalidProfile=policy();invalidProfile.profile.surface={};bad.push(invalidProfile);
 const injectedProfile=policy();injectedProfile.profile.ready=true;bad.push(injectedProfile);
 for(const p of bad)blocked(assessQueueCompatibility(evidence(),p),'invalid_policy');
 blocked(assessQueueCompatibility(unavailable(),invalidReference),'invalid_policy');
});

test('model claims, probe flags, malformed contract states and invalid epochs are not valid evidence',()=>{
 for(const e of [null,[],{},'verified'])blocked(assessQueueCompatibility(e,policy()),'invalid_evidence');
 for(const name of ['probePassed','ready','fingerprint','grantsApprove']){const e=evidence();e[name]=name==='fingerprint'?hash():true;blocked(assessQueueCompatibility(e,policy(true)),'invalid_evidence');}
 for(const state of ['projection_failed','compatible','verified']){const e=evidence();e.contract.state=state;blocked(assessQueueCompatibility(e,policy()),'invalid_evidence');}
 for(const epoch of ['',null,'space epoch','bad\u0000epoch','x'.repeat(1025)]){const e=evidence();e.socketEpoch=epoch;e.contract.socketEpoch=epoch;blocked(assessQueueCompatibility(e,policy()),'invalid_evidence');}
 const extra=evidence();extra.contract.requiresProbe=false;blocked(assessQueueCompatibility(extra,policy()),'invalid_evidence');
});

test('qualified policy may recognize another validated projection, never override invalid used shape',()=>{
 const d=documents();d['synthetic.json'].properties.message.maxLength=10;
 const p=policy();p.profile.verifiedFingerprints=[hash(d)];
 assert.equal(assessQueueCompatibility(evidence(d),p).level,'verified');
 delete d['synthetic.json'].properties.message;
 blocked(assessQueueCompatibility(evidence(d),p),'projection_used_field_missing');
});

test('a fingerprint for another surface cannot qualify this surface',()=>{
 const other:UsedSurface={'different.request':surface['synthetic.request']},p=policy();
 p.profile.verifiedFingerprints=[hash(documents(),other)];
 assert.notEqual(p.profile.verifiedFingerprints[0],hash());
 assert.equal(assessQueueCompatibility(evidence(),p).level,'contract_checked');
});

test('unsupported refs/limits are blocked without raw schema details or D6 fallback',()=>{
 const ref=documents();ref['synthetic.json'].properties.message={$ref:'https://private.example/sensitive'};
 blocked(assessQueueCompatibility(evidence(ref),policy()),'projection_unsupported_or_cyclic_ref');
 const limit=documents();limit['synthetic.json'].properties.message.enum=Array.from({length:257},(_,i)=>String(i));
 blocked(assessQueueCompatibility(evidence(limit),policy()),'projection_invalid_enum');
 const secret=documents();secret['synthetic.json'].properties.message.privateKeyword='private-remote-detail';
 const result=assessQueueCompatibility(evidence(secret),policy());
 blocked(result,'projection_unsupported_keyword');assert.ok(!JSON.stringify(result).includes('private-remote-detail'));
});

test('inert frozen inputs are not mutated and output context retains no mutable input alias',()=>{
 const freeze=(value:any):any=>{if(!value||typeof value!=='object')return value;for(const child of Object.values(value))freeze(child);return Object.freeze(value);};
 const e=evidence(),p=policy(true),before=JSON.stringify([e,p]);
 const first=assessQueueCompatibility(freeze(e),freeze(p));assert.equal(first.level,'verified');assert.equal(JSON.stringify([e,p]),before);
 const mutable=evidence(),second=assessQueueCompatibility(mutable,policy());
 mutable.daemonVersion='0.999.0';mutable.desktopVersion='0.999.0';mutable.socketEpoch='replaced';
 if(second.level!=='blocked')assert.deepEqual(second.context,context);else assert.fail('fixture must be valid');
});

test('all historical exact tuples remain separate and no projection is fabricated for them',()=>{
 const base={daemonVersion:desktopQueuePin.daemon,desktopVersion:desktopQueuePin.desktop,addSchema:desktopQueuePin.addSchema,responseSchema:desktopQueuePin.responseSchema};
 const tuples=[base,{...base,desktopVersion:'0.166.0-alpha.6'},{...base,desktopVersion:'0.167.0-alpha.3.2',desktopAddSchema:'f6466a8f06cd4e68ec1999d06a0d70a1ddc339c0cb1baf12ee966a999fead17c',desktopResponseSchema:'896a82716b432a8aa4d190591bcfa86adacdacb91ec5ec2c9c75ff6562561256'}];
 for(const tuple of tuples){assert.equal(matchesDesktopQueueTuple(tuple),true);blocked(assessQueueCompatibility(tuple,policy()),'invalid_evidence');}
 assert.equal(matchesDesktopQueueTuple({...base,daemonVersion:'0.167.1'}),false);
});
