// Temp-directory/fake-target subprocess fixture. No Fleet configuration or transport.
import { createInterface } from 'node:readline';
import { AllowedSessionsStore, StoreError, type WriteStage } from '../lib/fleet-codex-allowlist-store.ts';
const [root, mode, alias = 'child', phase] = process.argv.slice(2);
const context = { hostProfile: 'fake-host', principal: 'fake-user', threadId: 'fake-A' };
const target = { project: 'fake-project', peer: 'fake-peer', sessionId: 'fake-session-1', startedAt: '2000-01-01T00:00:00Z' };
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const emit = (message: object) => process.stdout.write(JSON.stringify(message)+'\n');
const wait = async () => { if ((await lines.next()).done) throw new Error('closed test barrier'); };
let paused = false;
const store = new AllowedSessionsStore(root, context, { checkpoint: async (stage: WriteStage) => {
  if (!paused && (mode === 'hold' && stage === 'locked' || mode === 'interrupt' && stage === phase)) {
    paused = true; emit({ stage }); await wait();
  }
} });
try {
  if (mode === 'hold') await store.open();
  else {
    await store.open();
    const h = mode === 'stale' || mode === 'roundtrip' ? await store.resolve('shop', [target]) : undefined;
    emit({ ready: true }); await wait();
    if (mode === 'stale') await store.grantSend(h!, [target]);
    else if (mode === 'roundtrip') {
      const decision = await store.authorize(h!, 'send', [target]);
      emit({ ok: true, decision });
    } else await store.enroll({ alias, target: { ...target, peer: alias } }, [{ ...target, peer: alias }]);
  }
  if (mode !== 'roundtrip') emit({ ok: true });
} catch (e) { emit({ ok: false, code: e instanceof StoreError ? e.code : 'FIXTURE_ERROR' }); }
finally { input.close(); }
