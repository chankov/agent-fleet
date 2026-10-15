import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageOwners} from './damage-guard-owners.ts';
const setup=()=>{let current={session:'session',taskToken:'token',taskId:'task',inputRevision:'revision'};let admitted=true;const registry=createDamageOwners({current:()=>current,admit:()=>admitted});return {registry,setCurrent:(v:Partial<typeof current>)=>{current={...current,...v};},deny:()=>{admitted=false;}};};
const spec={owner:'child',tools:['bash','write'],cwd:process.cwd()};
test('registry rejects forged, cross-session, stale and unavailable admission authority',()=>{
 const a=setup(),b=setup(),cap=a.registry.register(spec);assert.ok(cap);
 assert.equal(a.registry.validate({} as any,'bash',process.cwd()),undefined);assert.equal(b.registry.validate(cap,'bash',process.cwd()),undefined);
 assert.equal(a.registry.validate(cap,'edit',process.cwd()),undefined);assert.equal(a.registry.validate(cap,'bash','/'),undefined);
 a.deny();assert.equal(a.registry.validate(cap,'bash',process.cwd()),undefined);
 for(const field of ['session','taskToken','taskId','inputRevision']){const s=setup(),c=s.registry.register(spec);s.setCurrent({[field]:'new'});assert.equal(s.registry.validate(c,'bash',process.cwd()),undefined);}
});
test('physical identities are fresh, descendant scope attenuates and revocation is transitive and idempotent',()=>{
 const {registry}=setup(),a=registry.register(spec),b=registry.register(spec);
 assert.notEqual(a.attempt,b.attempt);assert.notEqual(a.owner,b.owner);assert.ok(Object.isFrozen(a));
 assert.throws(()=>registry.register({...spec,tools:['edit']},a));assert.throws(()=>registry.register({...spec,cwd:'/'},a));
 const child=registry.register({...spec,tools:['bash']},a),grandchild=registry.register({...spec,tools:['bash']},child);
 registry.revoke(a);registry.revoke(a);assert.equal(child.signal.aborted,true);assert.equal(grandchild.signal.aborted,true);assert.ok(registry.validate(b,'bash',process.cwd()));registry.dispose();assert.equal(b.signal.aborted,true);
});
test('registry rejects empty authoritative identity fields at registration',()=>{
 for(const field of ['session','taskToken','taskId','inputRevision']){const s=setup();s.setCurrent({[field]:''});assert.throws(()=>s.registry.register(spec));}
});
