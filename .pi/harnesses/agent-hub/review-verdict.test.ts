import test from 'node:test';
import assert from 'node:assert/strict';
import { affirmativeReviewVerdict } from './review-verdict.ts';
for(const output of ['**Verdict: APPROVE.**','summary\r\n **Verdict: APPROVE** \r\n','APPROVE','Verdict: APPROVE','**Verdict:** APPROVE','**Verdict**: APPROVE','  **Verdict:** APPROVE — no blockers']) {
 test('recognizes explicit native reviewer verdict '+output,()=>assert.equal(affirmativeReviewVerdict(output),true));
}
for(const output of ['APPROVE\n**Verdict: REJECT.**','**Verdict: REJECT.**\n**Verdict: APPROVE.**','Example: **Verdict: APPROVE.**','**Verdict: APPROVE.** is an example','**Verdict: APPROVED.**','...without another test run.**Verdict:** APPROVE.','No APPROVE verdict','Verdict: APPROVED','not APPROVE','APPROVE\nREJECT','APPROVE\n**Verdict:** REJECT','**Verdict:** APPROVE\nVerdict: REJECT','{"summary":"APPROVE"}','**Verdict:** REJECT']) {
 test('does not infer or override negative verdict '+JSON.stringify(output),()=>assert.equal(affirmativeReviewVerdict(output),false));
}
