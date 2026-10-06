import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProcessClassification, createProcessState, evaluateProcessObligations, noteProcessStage, processPreEffectGate } from './process-obligations.ts';

for (const only of ['plan', 'acceptance', 'review'] as const) test(`${only} alone cannot close independent stages even at lower spend tier`, () => {
 const base = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'wide work' }).state;
 const state = noteProcessStage(base, only, { evidenceRef: `${only}:evidence`, revision: 'current' });
 const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: 'trivial', currentRevision: 'current' });
 assert.equal(verdict.accepted, false);
 for (const stage of ['plan', 'acceptance', 'review'] as const) assert.equal(verdict.obligations[stage].status, stage === only ? 'satisfied' : 'open');
 assert.equal(processPreEffectGate(state, 'prove', '', 'current')?.reason, only === 'acceptance' || only === 'plan' || only === 'review' ? 'process_obligations_open' : undefined);
});
test('current verification and independent review are revision bound, plan is occurrence only', () => {
 let state = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'wide work' }).state;
 for (const stage of ['plan', 'acceptance', 'review'] as const) state = noteProcessStage(state, stage, { evidenceRef: `${stage}:evidence`, revision: 'current' });
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: 'small', currentRevision: 'current' }).accepted, true);
 const stale = evaluateProcessObligations(state, { writable: true, budgetTier: 'project', currentRevision: 'changed' });
 assert.equal(stale.accepted, false); assert.equal(stale.obligations.plan.status, 'satisfied');
 assert.equal(stale.obligations.acceptance.status, 'open'); assert.equal(stale.obligations.review.status, 'open');
});
