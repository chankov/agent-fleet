import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelProfiles, validateProfile, agentSelection, childSelection } from './model-profiles.ts';
const local = `local:\n  version: 2\n  defaults: { model: 'omlx/laguna', thinking: off }\n  allowed-models: ['omlx/laguna', 'omlx/qwen']\n  agents:\n    documenter: omlx/qwen\n  subagents:\n    planner:\n      rules: omlx/qwen\n  panel:\n    - { name: laguna, model: 'omlx/laguna', integrator: true }\n    - { name: qwen, model: 'omlx/qwen' }\n`;
test('legacy maps remain compatible; complete profiles resolve future roles and child exceptions', () => {
    const { profiles, errors } = parseModelProfiles('sol:\n  builder: cloud/sol\n' + local);
    assert.deepEqual(errors, []);
    assert.deepEqual(profiles.sol, { builder: 'cloud/sol' });
    const p = profiles.local as any;
    assert.deepEqual(agentSelection(p, 'new-agent'), { model: 'omlx/laguna', thinking: 'off' });
    assert.deepEqual(agentSelection(p, 'documenter'), { model: 'omlx/qwen', thinking: 'off' });
    assert.deepEqual(childSelection(p, 'planner', 'rules'), { model: 'omlx/qwen', thinking: 'off' });
    assert.deepEqual(childSelection(p, 'planner', 'future-child'), { model: 'omlx/laguna', thinking: 'off' });
});
test('invalid profiles fail as a whole without dropping valid siblings', () => {
    const r = parseModelProfiles(local + 'bad:\n  version: 2\n  defaults: {model: cloud/x}\n  unknown: yes\n');
    assert.deepEqual(Object.keys(r.profiles), ['local']);
    assert.match(r.errors.join('\n'), /unknown/);
    assert.match(parseModelProfiles('x: [invalid]').errors.join('\n'), /mapping/);
    assert.match(parseModelProfiles('x: {builder: a/b, builder: c/d}').errors.join('\n'), /unique|duplicate/i);
});
test('allowlist and named role validation reject external models and typos', () => {
    assert.match(parseModelProfiles(local.replace('documenter: omlx/qwen', 'documenter: cloud/x')).errors.join('\n'), /allowed-models/);
    const p = parseModelProfiles(local).profiles.local;
    const defs = [{ name: 'documenter' }, { name: 'planner', subagents: { rules: { model: 'cloud/a' } } }];
    assert.deepEqual(validateProfile(p, defs), []);
    assert.match(validateProfile(p, [{ name: 'planner', subagents: {} }]).join('\n'), /documenter|rules/);
});
