import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelProfiles, parseCompleteProfile, validateProfile, agentSelection, childSelection, practiceSelection } from './model-profiles.ts';
const local = `local:\n  version: 2\n  defaults: { model: 'omlx/laguna', thinking: off }\n  allowed-models: ['omlx/laguna', 'omlx/qwen']\n  agents:\n    documenter: omlx/qwen\n  subagents:\n    planner:\n      rules: omlx/qwen\n  panel:\n    - { name: laguna, model: 'omlx/laguna', integrator: true }\n    - { name: qwen, model: 'omlx/qwen' }\n`;
test('legacy maps remain compatible; complete profiles resolve future roles and child exceptions', () => {
    const { profiles, errors } = parseModelProfiles('sol:\n  builder: cloud/sol\n' + local);
    assert.deepEqual(errors, []);
    assert.deepEqual(profiles.sol, { builder: 'cloud/sol' });
    const p = profiles.local as any;
    assert.equal(p.assist, undefined);
    assert.deepEqual(agentSelection(p, 'new-agent'), { model: 'omlx/laguna', thinking: 'off' });
    assert.deepEqual(agentSelection(p, 'documenter'), { model: 'omlx/qwen', thinking: 'off' });
    assert.deepEqual(childSelection(p, 'planner', 'rules'), { model: 'omlx/qwen', thinking: 'off' });
    assert.deepEqual(childSelection(p, 'planner', 'future-child'), { model: 'omlx/laguna', thinking: 'off' });
});
test('assist accepts only the four optional booleans and preserves explicit on/off values', () => {
    const base = { version: 2 as const, defaults: { model: 'omlx/laguna', thinking: 'off' } };
    const allOff = parseCompleteProfile({ ...base, assist: { 'deterministic-tools': false, 'bounded-output': false, 'write-isolation': false, 'return-extraction': false } });
    assert.deepEqual(allOff.assist, { 'deterministic-tools': false, 'bounded-output': false, 'write-isolation': false, 'return-extraction': false });
    const allOn = parseCompleteProfile({ ...base, assist: { 'deterministic-tools': true, 'bounded-output': true, 'write-isolation': true, 'return-extraction': true } });
    assert.deepEqual(allOn.assist, { 'deterministic-tools': true, 'bounded-output': true, 'write-isolation': true, 'return-extraction': true });
    assert.throws(() => parseCompleteProfile({ ...base, assist: { 'return-extraction': 'yes' } }), /boolean/);
    assert.throws(() => parseCompleteProfile({ ...base, assist: { 'bounded-output': 'yes' } }), /boolean/);
    assert.throws(() => parseCompleteProfile({ ...base, assist: { 'secret-cloud': true } }), /unknown key/);
    assert.throws(() => parseCompleteProfile({ ...base, 'bounded-output': true }), /unknown key/);
});
test('invalid profiles fail as a whole without dropping valid siblings', () => {
    const r = parseModelProfiles(local + 'bad:\n  version: 2\n  defaults: {model: cloud/x}\n  unknown: yes\n');
    assert.deepEqual(Object.keys(r.profiles), ['local']);
    assert.match(r.errors.join('\n'), /unknown/);
    assert.match(parseModelProfiles('x: [invalid]').errors.join('\n'), /mapping/);
    assert.match(parseModelProfiles('x: {builder: a/b, builder: c/d}').errors.join('\n'), /unique|duplicate/i);
});
test('an older profile that still maps the retired orchestrator persona stays valid', () => {
    assert.deepEqual(validateProfile({ orchestrator: 'a/b', builder: 'a/b' } as any, [{ name: 'builder', model: 'a/b' } as any]), []);
    assert.match(validateProfile({ typo: 'a/b' } as any, [{ name: 'builder', model: 'a/b' } as any]).join('\n'), /unknown persona "typo"/);
});
test('allowlist and named role validation reject external models and typos', () => {
    assert.match(parseModelProfiles(local.replace('documenter: omlx/qwen', 'documenter: cloud/x')).errors.join('\n'), /allowed-models/);
    const p = parseModelProfiles(local).profiles.local;
    const defs = [{ name: 'documenter' }, { name: 'planner', subagents: { rules: { model: 'cloud/a' } } }];
    assert.deepEqual(validateProfile(p, defs), []);
    assert.match(validateProfile(p, [{ name: 'planner', subagents: {} }]).join('\n'), /documenter|rules/);
});
test('<role>.<practice> keys parse in flat and complete profiles and validate the role, the practice and the flat model list', () => {
    const r = parseModelProfiles(`flat:\n  editor: cloud/sol\n  editor.planning: cloud/astra\ncomplete:\n  version: 2\n  defaults: { model: 'omlx/a' }\n  agents:\n    editor.planning: { model: 'omlx/b', thinking: high }\n`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.profiles.flat, { editor: 'cloud/sol', 'editor.planning': 'cloud/astra' });
    assert.deepEqual((r.profiles.complete as any).agents['editor.planning'], { model: 'omlx/b', thinking: 'high' });
    assert.deepEqual(practiceSelection(r.profiles.complete as any, 'editor', 'planning'), { model: 'omlx/b', thinking: 'high' });
    assert.equal(practiceSelection(r.profiles.complete as any, 'editor', 'testing'), undefined);
    assert.match(parseModelProfiles('x:\n  editor.planning.deep: a/b\n').errors.join('\n'), /invalid persona\/model entry/);
    const defs = [{ name: 'editor', model: 'cloud/sol', models: ['cloud/astra'] }];
    assert.deepEqual(validateProfile(r.profiles.flat, defs), []);
    assert.deepEqual(validateProfile(r.profiles.complete, defs), []);
    assert.match(validateProfile({ 'editor.planning': 'cloud/other' }, defs).join('\n'), /editor\.planning does not declare cloud\/other \(add it to the editor models: list\)/);
    const unknownPractice = validateProfile({ 'editor.planing': 'cloud/astra' }, defs).join('\n');
    assert.match(unknownPractice, /unknown practice "planing" in "editor\.planing" — known practices: research, architecture, planning/);
    assert.match(validateProfile({ version: 2, defaults: { model: 'omlx/a' }, agents: { 'editor.typo': { model: 'omlx/a' } } } as any, defs).join('\n'), /unknown practice "typo"/);
    assert.match(validateProfile({ 'builder.planning': 'cloud/astra' }, defs).join('\n'), /unknown role "builder" in "builder\.planning"/);
});
test('the shipped mix-max profile keeps the retired planner and security-auditor model intent', async () => {
    const { readFileSync } = await import('node:fs');
    const { profiles, errors } = parseModelProfiles(readFileSync('.pi/agents/model-profiles.yaml', 'utf8'));
    assert.deepEqual(errors, []);
    assert.equal((profiles['mix-max'] as any)['editor.planning'], 'openai-codex/gpt-6.2-astra');
    assert.equal((profiles['mix-max'] as any)['reviewer.security'], 'openai-codex/gpt-6.2-sol');
    const { parseAgentFile } = await import('./agents.ts');
    const defs = ['editor', 'reviewer', 'researcher'].map(name => parseAgentFile(`agents/${name}.md`)!);
    for (const [name, profile] of Object.entries(profiles)) assert.deepEqual(validateProfile(profile, defs), [], name);
});
