import test from 'node:test';
import assert from 'node:assert/strict';
import {damageInputAudit,damagePreview} from './damage-control-presentation.ts';

test('preview removes credentials and terminal/bidi controls before clipping',()=>{
 const raw='TOKEN=synthetic_fixture_secret\u001b[31m\u202e rm .github/a';
 const preview=damagePreview(raw);
 assert.ok(!preview.includes('synthetic_fixture_secret'));
 assert.ok(!preview.includes('\u001b'));
 assert.ok(!preview.includes('\u202e'));
 assert.match(preview,/REDACTED/);
 assert.match(damagePreview('a'.repeat(1000)),/truncated/);
});

test('audit contains only version, full-input hash and byte count, no secret or raw input',()=>{
 const first=damageInputAudit({command:'echo password=synthetic_fixture_secret'});
 assert.deepEqual(Object.keys(first),['schema','sha256','bytes']);
 assert.match(first.sha256,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(first).includes('synthetic_fixture_secret'));
 assert.notEqual(first.sha256,damageInputAudit({command:'echo other'}).sha256);
 const prefix='x'.repeat(600);
 assert.notEqual(damageInputAudit(prefix+'a').sha256,damageInputAudit(prefix+'b').sha256);
});
