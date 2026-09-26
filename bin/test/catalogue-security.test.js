import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../../catalog/rules/security/${name}.md`, import.meta.url), 'utf8');
test('authorization precedes effects and fails closed with observable checks', () => {
 const text = read('authorization-before-effects');
 for (const pattern of [/before mutations/, /Deny when required ownership/, /background or alternate entry points/, /change between checking and writing/, /no mutation or queued side effect/]) assert.match(text, pattern);
 assert.doesNotMatch(text, /LogosService|CanAccessEventAsync|EventTypes\.Unknown/);
});
test('tenant scope is trusted and enforced beyond authentication', () => {
 const text = read('trusted-tenant-scope');
 for (const pattern of [/not solely from client-supplied/, /only a scope already authorized/, /authentication at the entry point alone is insufficient/, /isolated between requests and jobs/, /at least two tenant contexts/, /no cross-tenant data disclosure or mutation/]) assert.match(text, pattern);
 assert.doesNotMatch(text, /RIN\.PublicAPI|IOrganizationsPublicApiService/);
});
