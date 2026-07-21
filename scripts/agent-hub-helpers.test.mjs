import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  delegateBudgetRefusal,
  DELEGATE_TREE_SPAWN_BUDGET,
  MAX_DELEGATE_DEPTH,
  normalizeDelegateRuntimeBudgets,
  parseTeamsYaml,
  planDelegateSpawn,
  READ_ONLY_TOOLS,
  resolveDelegateTools,
  safeAgentKey,
  safePathWithin,
} from '../.pi/harnesses/agent-hub/helpers.ts';

test('parseTeamsYaml accepts trailing whitespace on team headers', () => {
  const teams = parseTeamsYaml(`default:\n  - planner\ndebug:  \n  - builder\ninfo:\t\n  - documenter\n`);

  assert.deepEqual(teams, {
    default: ['planner'],
    debug: ['builder'],
    info: ['documenter'],
  });
});

test('safeAgentKey accepts only lowercase slug keys', () => {
  assert.equal(safeAgentKey('code-reviewer'), 'code-reviewer');
  assert.equal(safeAgentKey('builder2'), 'builder2');

  for (const invalid of [
    '',
    '../code-reviewer',
    'code-reviewer/../../x',
    'code reviewer',
    'Code-Reviewer',
    'code_reviewer',
    '.code-reviewer',
    'code-reviewer.',
    '-code-reviewer',
    'code-reviewer-',
  ]) {
    assert.throws(() => safeAgentKey(invalid), /Invalid agent key|Agent key/);
  }
});

test('safePathWithin refuses traversal outside the base directory', () => {
  const base = resolve('/tmp/agent-hub-test');

  assert.equal(
    safePathWithin(base, 'delegations', 'code-reviewer'),
    join(base, 'delegations', 'code-reviewer'),
  );
  assert.throws(() => safePathWithin(base, '..', 'outside'), /outside/);
  assert.throws(() => safePathWithin(base, '/tmp/outside'), /outside/);
});

test('package files include all harness TypeScript files', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
  assert.ok(pkg.files.includes('.pi/harnesses/*/*.ts'));
});

test('delegate budgets clamp depth and refuse exhausted depth or spawn budgets', () => {
  const budgets = normalizeDelegateRuntimeBudgets({
    depth: 99,
    callBudget: 99,
    remainingSpawns: 99,
  });

  assert.deepEqual(budgets, {
    depth: MAX_DELEGATE_DEPTH,
    callBudget: DELEGATE_TREE_SPAWN_BUDGET,
    remainingSpawns: DELEGATE_TREE_SPAWN_BUDGET,
  });
  assert.match(
    delegateBudgetRefusal({ ...budgets, depth: 0, callCount: 0 }),
    /depth budget is 0/,
  );
  assert.match(
    delegateBudgetRefusal({ ...budgets, remainingSpawns: 0, callCount: 0 }),
    /tree-wide spawn budget exhausted/,
  );
  assert.match(
    delegateBudgetRefusal({ ...budgets, callCount: DELEGATE_TREE_SPAWN_BUDGET }),
    /process call budget exhausted/,
  );
  assert.equal(delegateBudgetRefusal({ ...budgets, callCount: 0 }), null);
});

test('delegate tool caps fail closed when they do not intersect available tools', () => {
  const refused = resolveDelegateTools({
    parentTools: 'read,bash,edit',
    roleTools: 'bash,edit',
    allowWrite: true,
    concurrent: true,
  });

  assert.equal(refused.baseTools, READ_ONLY_TOOLS);
  assert.equal(refused.effectiveTools, '');
  assert.equal(refused.refused, true);
  assert.equal(refused.writeDowngraded, true);

  const writable = resolveDelegateTools({
    parentTools: 'read,bash,edit',
    roleTools: 'bash,edit',
    allowWrite: true,
    concurrent: false,
  });

  assert.equal(writable.effectiveTools, 'bash,edit');
  assert.equal(writable.refused, false);
});

test('delegate spawn planning decrements tree budget and withholds delegate config at depth 0', () => {
  const plan = planDelegateSpawn({
    tag: 'root',
    roleKey: 'quality',
    childSeq: 1,
    depth: MAX_DELEGATE_DEPTH,
    remainingSpawns: DELEGATE_TREE_SPAWN_BUDGET,
    effectiveTools: READ_ONLY_TOOLS,
    damageControl: '/repo/.pi/harnesses/damage-control-continue/index.ts',
    delegateExt: '/repo/.pi/harnesses/agent-hub/delegate.ts',
  });

  assert.equal(plan.childId, 'quality-1');
  assert.equal(plan.nextRemainingSpawns, DELEGATE_TREE_SPAWN_BUDGET - 1);
  assert.equal(plan.childDepth, 0);
  assert.equal(plan.childRemainingSpawns, DELEGATE_TREE_SPAWN_BUDGET - 1);
  assert.equal(plan.childCanDelegate, false);
  assert.equal(plan.includeDelegateConfig, false);
  assert.deepEqual(plan.childExtensions, ['/repo/.pi/harnesses/damage-control-continue/index.ts']);
  assert.equal(plan.childTools, READ_ONLY_TOOLS);
});

test('normalizeAgentInput maps display names and separators onto persona slugs', async () => {
  const { normalizeAgentInput } = await import('../.pi/harnesses/agent-hub/helpers.ts');
  assert.equal(normalizeAgentInput('Test Engineer'), 'test-engineer');
  assert.equal(normalizeAgentInput('test_engineer'), 'test-engineer');
  assert.equal(normalizeAgentInput('  Builder '), 'builder');
  assert.equal(normalizeAgentInput('code-reviewer'), 'code-reviewer');
  assert.equal(normalizeAgentInput('Deep  Researcher'), 'deep-researcher');
});

test('taskFingerprint collides on trivial rewording but not on different tasks', async () => {
  const { taskFingerprint } = await import('../.pi/harnesses/agent-hub/helpers.ts');
  const a = taskFingerprint('Builder', 'Implement the login form, then run tests.');
  const b = taskFingerprint('builder', '  implement the LOGIN form — then run tests!! ');
  assert.equal(a, b);
  assert.notEqual(a, taskFingerprint('builder', 'Implement the signup form, then run tests.'));
  assert.notEqual(a, taskFingerprint('test-engineer', 'Implement the login form, then run tests.'));
});

test('upsertTeamInYaml replaces one block, preserving comments and other teams', async () => {
  const { upsertTeamInYaml, parseTeamsYaml: parse } = await import('../.pi/harnesses/agent-hub/helpers.ts');
  const raw = '# header comment\n\ndefault:\n  - planner\n  - builder\n\ndebug:\n  - builder\n';
  const next = upsertTeamInYaml(raw, 'default', ['builder', 'code-reviewer']);
  assert.match(next, /^# header comment\n/);
  assert.deepEqual(parse(next), {
    default: ['builder', 'code-reviewer'],
    debug: ['builder'],
  });
});

test('upsertTeamInYaml appends a new team at the end', async () => {
  const { upsertTeamInYaml, parseTeamsYaml: parse } = await import('../.pi/harnesses/agent-hub/helpers.ts');
  const raw = 'default:\n  - planner\n';
  const next = upsertTeamInYaml(raw, 'custom', ['builder', 'bowser']);
  assert.deepEqual(parse(next), {
    default: ['planner'],
    custom: ['builder', 'bowser'],
  });
});
