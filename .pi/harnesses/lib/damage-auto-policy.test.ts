import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadDamageAutoPolicy,evaluateDamageAutoPolicy} from './damage-auto-policy.ts';
const rule={id:'fixture',decision:'allow_once',source:'damage_control_path',category:'read_only',tool:'write',pattern:'fixture-protected/',operation:'write',expiresAt:new Date(Date.now()+60000).toISOString(),reason:'Explicit synthetic fixture rule'};
function fixture(t:any){const cwd=mkdtempSync(join(tmpdir(),'damage-auto-'));mkdirSync(join(cwd,'.pi'),{mode:0o700});t.after(()=>rmSync(cwd,{force:true,recursive:true}));const file=join(cwd,'.pi','damage-control-auto-policy.yaml');return {cwd,file,write:(value:unknown)=>writeFileSync(file,JSON.stringify(value),{mode:0o600})};}
const attempt=(cwd:string)=>({source:'damage_control_path',category:'read_only',tool:'write',pattern:'fixture-protected/',analysis:'static_operands' as const,operands:[{path:join(cwd,'fixture-protected/a'),operation:'write' as const}],cwd,presentationSafe:true});

test('missing/empty/empty rules are behavior-preserving disabled policies, with no file creation',t=>{
 const f=fixture(t);assert.equal(loadDamageAutoPolicy(f.cwd).status,'disabled');
 writeFileSync(f.file,'',{mode:0o600});assert.equal(loadDamageAutoPolicy(f.cwd).status,'disabled');
 f.write({version:1,rules:[]});const policy=loadDamageAutoPolicy(f.cwd);assert.equal(policy.status,'disabled');assert.equal(evaluateDamageAutoPolicy(policy,attempt(f.cwd)),null);
});

test('exact static single-operand match has distinct auto_policy identity; expiry/revoke changes invalidate it',t=>{
 const f=fixture(t);f.write({version:1,rules:[rule]});const first=loadDamageAutoPolicy(f.cwd);assert.equal(first.status,'valid');
 const result=evaluateDamageAutoPolicy(first,attempt(f.cwd))!;assert.equal(result.decisionSource,'auto_policy');assert.equal(result.decision,'allow_once');assert.equal(result.policyDigest,first.digest);
 assert.equal(evaluateDamageAutoPolicy(first,attempt(f.cwd),Date.parse(rule.expiresAt)),null);
 f.write({version:1,rules:[]});assert.notEqual(loadDamageAutoPolicy(f.cwd).digest,first.digest);
});

test('conservative text, multiple operands, unsafe preview, wrong category/tool/pattern and D6 hold never auto-allow',t=>{
 const f=fixture(t);f.write({version:1,rules:[rule]});const policy=loadDamageAutoPolicy(f.cwd),base=attempt(f.cwd);
 for(const mutation of [{analysis:'conservative_text' as const},{operands:[...base.operands,{path:join(f.cwd,'second'),operation:'write' as const}]},{presentationSafe:false},{category:'no_delete'},{tool:'bash'},{pattern:'different'},{d6Hold:true},{operands:[{path:join(f.cwd,'.pi','damage-control-auto-policy.yaml'),operation:'write' as const}]}])assert.equal(evaluateDamageAutoPolicy(policy,{...base,...mutation}),null);
});

test('invalid/secret/zero-access allow/unknown fields and duplicate IDs disable auto, not the human path',t=>{
 const f=fixture(t);
 for(const value of [{version:2,rules:[rule]},{version:1,rules:[{...rule,decision:'allow_session'}]},{version:1,rules:[{...rule,category:'zero_access'}]},{version:1,rules:[rule,rule]},{version:1,rules:[{...rule,extra:true}]},{version:1,rules:[{...rule,reason:'TOKEN=synthetic_fixture_secret'}]}]){
  f.write(value);const p=loadDamageAutoPolicy(f.cwd);assert.equal(p.status,'invalid');assert.equal(evaluateDamageAutoPolicy(p,attempt(f.cwd)),null);
 }
 writeFileSync(f.file,'version: 1\nversion: 1\nrules: []');assert.equal(loadDamageAutoPolicy(f.cwd).status,'invalid');
});

test('symlink/oversized input refuses without repair or permissive fallback',t=>{
 const f=fixture(t);f.write({version:1,rules:[rule]});const outside=join(f.cwd,'actual');writeFileSync(outside,'version: 1\nrules: []');rmSync(f.file);symlinkSync(outside,f.file);assert.equal(loadDamageAutoPolicy(f.cwd).status,'invalid');rmSync(f.file);writeFileSync(f.file,'x'.repeat(32769));assert.equal(loadDamageAutoPolicy(f.cwd).status,'invalid');
});
