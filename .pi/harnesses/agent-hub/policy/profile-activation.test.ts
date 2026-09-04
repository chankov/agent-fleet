import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileActivation } from './profile-activation.ts';
import { readActiveProfile } from './profile-runtime.ts';
const p: any = { version: 2, defaults: { model: 'omlx/laguna', thinking: 'off' }, 'allowed-models': ['omlx/laguna'] };
function fixture() {
    let dispatcher = { model: 'cloud/root', thinking: 'high' }, applied: any, busy = false, available = ['cloud/root', 'cloud/sol', 'omlx/laguna'];
    const env: NodeJS.ProcessEnv = {};
    let selections = 0;
    const activation = createProfileActivation({ busy: () => busy, defs: () => [{ name: 'builder', model: 'cloud/sol' }], available: async () => available, dispatcher: () => dispatcher, setDispatcher: async (s) => { selections++; dispatcher = s as any; return true; }, apply: v => { applied = v; return ['builder']; }, env });
    return { activation, env, get dispatcher() { return dispatcher; }, get applied() { return applied; }, get selections() { return selections; }, setBusy(v: boolean) { busy = v; }, setAvailable(v: string[]) { available = v; } };
}
test('activation preflights every model before changing state and restores dispatcher on legacy switch', async () => {
    const f = fixture();
    await f.activation.activate('local', p);
    assert.equal(f.dispatcher.model, 'omlx/laguna');
    assert.equal(f.dispatcher.thinking, 'off');
    assert.equal(readActiveProfile(f.env)?.name, 'local');
    f.setAvailable(['cloud/root']);
    await assert.rejects(f.activation.activate('other', { ...p, defaults: { model: 'omlx/missing' } }), /allowed-models|unavailable/);
    assert.equal(f.dispatcher.model, 'omlx/laguna');
    assert.equal(f.selections, 1);
    f.setAvailable(['cloud/root', 'cloud/sol']);
    await f.activation.activate('sol', { builder: 'cloud/sol' });
    assert.deepEqual(f.dispatcher, { model: 'cloud/root', thinking: 'high' });
    assert.equal(readActiveProfile(f.env), undefined);
});
test('busy fleet and unavailable local model refuse before applying anything', async () => {
    const f = fixture();
    f.setBusy(true);
    await assert.rejects(f.activation.activate('local', p), /wait/);
    assert.equal(f.selections, 0);
    f.setBusy(false);
    f.setAvailable(['cloud/root']);
    await assert.rejects(f.activation.activate('local', p), /unavailable/);
    assert.equal(f.selections, 0);
    assert.equal(f.applied, undefined);
    assert.equal(readActiveProfile(f.env), undefined);
});
