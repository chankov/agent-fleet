import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPiAgent, spawnPiAgentWithModelFallback } from './spawn.ts';
import { PROFILE_ENV, setActiveProfile, readActiveProfile, profileWorkInFlight, profilePanel } from './policy/profile-runtime.ts';
const profile: any = { version: 2, defaults: { model: 'omlx/laguna', thinking: 'off' }, fallback: 'none', routing: 'native', 'allowed-models': ['omlx/laguna', 'omlx/qwen'], panel: [{ name: 'laguna', model: 'omlx/laguna', integrator: true }, { name: 'qwen', model: 'omlx/qwen' }] };
test('actual child launch inherits profile; missing local provider never attempts cloud fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-profile-'));
    const log = join(dir, 'attempts');
    const previous = process.env[PROFILE_ENV];
    writeFileSync(join(dir, 'pi'), `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv,profile:process.env.${PROFILE_ENV}})+'\\n');console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));`, { mode: 0o755 });
    setActiveProfile({ name: 'local', profile });
    try {
        const opts = { model: 'omlx/laguna', thinking: 'off', tools: 'read', sessionFile: join(dir, 'session'), prompt: 'hello', env: { PATH: dir + ':' + process.env.PATH, CAPTURE: log, [PROFILE_ENV]: '' } };
        const denied = await spawnPiAgent({ ...opts, model: 'cloud/sol' });
        assert.equal(denied.exitCode, 1);
        assert.match(denied.spawnError!, /refuses/);
        assert.equal(existsSync(log), false);
        const failed = await spawnPiAgentWithModelFallback(opts, 'cloud/sol');
        assert.equal(failed.exitCode, 1);
        const attempts = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
        assert.equal(attempts.length, 1);
        assert.equal(JSON.parse(attempts[0].profile).name, 'local');
        assert.ok(attempts[0].args.includes('omlx/laguna'));
        assert.equal(profileWorkInFlight(), 0);
    }
    finally {
        if (previous === undefined)
            delete process.env[PROFILE_ENV];
        else
            process.env[PROFILE_ENV] = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});
test('profile panel is self contained and refuses unrelated external panels', () => {
    const active = { name: 'local', profile };
    assert.equal(profilePanel('local', active)?.[1].model, 'omlx/qwen');
    assert.throws(() => profilePanel('cloud-panel', active), /owns/);
    assert.throws(() => readActiveProfile({ [PROFILE_ENV]: 'broken' }), /Invalid active/);
});
