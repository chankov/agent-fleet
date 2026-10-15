import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneUseAuthority } from './action-authorization.ts';
test('one-use authority is bound to exact key and unforgeable object identity',()=>{
 const authority=createOneUseAuthority(),grant=authority.issue('exact');
 assert.equal(authority.consume({} as typeof grant,'exact'),false);
 assert.equal(authority.consume(grant,'changed'),false);
 assert.equal(authority.consume(grant,'exact'),true);
 assert.equal(authority.consume(grant,'exact'),false);
});
