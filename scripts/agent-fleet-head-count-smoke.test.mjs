import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import registerDelegate from '../.pi/harnesses/agent-hub/delegate.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function headChangedFileCount(cwd) {
  return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).split(/\r?\n/).filter(Boolean).length;
}

function createFakePi(tmp) {
  const fakePi = join(tmp, 'pi');
  writeFileSync(fakePi, `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const mode = process.env.HEAD_COUNT_SMOKE_MODE || 'success';
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
if (mode === 'hang') {
  emit({ type: 'tool_execution_start', toolCallId: 'head-count', toolName: 'read', args: {} });
  setInterval(() => {}, 1000);
} else if (mode === 'failure') {
  process.stderr.write('intentional delegated child failure\\n');
  process.exit(7);
} else {
  const count = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).split(/\\r?\\n/).filter(Boolean).length;
  const reported = mode === 'mismatch' ? count + 1 : count;
  const text = 'HEAD_FILE_COUNT: ' + reported + (mode === 'no-digest' ? '' : '\\nDIGEST:\\nDelegated git diff-tree count: ' + reported);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  emit({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 1, output: 1 } }] });
}
`);
  chmodSync(fakePi, 0o755);
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function runSmoke(mode = 'success') {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-fleet-head-count-smoke-'));
  try {
    createFakePi(tmp);
    return await withEnv({
      PATH: `${tmp}:${process.env.PATH ?? ''}`,
      HEAD_COUNT_SMOKE_MODE: mode,
      AGENT_HUB_DELEGATE_CONFIG: JSON.stringify({
        persona: 'builder', tag: 'head-count-smoke',
        roles: { verifier: { model: 'smoke/model' } },
        depth: 1, callBudget: 1, remainingSpawns: 1,
        parentTools: 'read,grep,find,ls', personaPrompt: '',
        eventDir: join(tmp, 'delegations'), delegateExt: join(repoRoot, '.pi/harnesses/agent-hub/delegate.ts'),
        reconSearchTimeoutMs: 100, turnDeadlineMs: 250, cwd: repoRoot,
      }),
    }, async () => {
      let tool;
      registerDelegate({ registerTool(definition) { tool = definition; } });
      assert.ok(tool, 'Agent Fleet hub delegate tool must register');

      const expected = headChangedFileCount(repoRoot);
      const result = await tool.execute('head-count-smoke', {
        role: 'verifier',
        instruction: 'Independently run git diff-tree --no-commit-id --name-only -r HEAD, count the paths, return HEAD_FILE_COUNT: <count>, and end with DIGEST:.',
      }, undefined, () => {});
      const status = result.details?.status;
      if (status === 'tool_timeout' || status === 'turn_timeout') {
        throw new Error(`Agent Fleet hub delegation timed out: ${status}`);
      }
      if (status !== 'done') {
        throw new Error(`Agent Fleet hub delegation failed: ${status ?? 'unknown status'}`);
      }
      if (!result.details?.digestFound || !result.details?.resultPath) {
        throw new Error('Missing delegation evidence: delegated child did not return DIGEST and result path');
      }

      const events = readFileSync(join(tmp, 'delegations', 'events.jsonl'), 'utf8');
      const childId = result.details.id;
      if (!events.includes(`"t":"spawn","id":"${childId}"`) || !events.includes(`"t":"exit","id":"${childId}"`)) {
        throw new Error('Missing delegation evidence: hub did not record delegated child spawn and exit');
      }
      const delegatedOutput = readFileSync(result.details.resultPath, 'utf8');
      const match = /^HEAD_FILE_COUNT:\s*(\d+)$/m.exec(delegatedOutput);
      if (!match) throw new Error('Missing delegation evidence: delegated child did not return HEAD_FILE_COUNT');
      const reported = Number(match[1]);
      if (reported !== expected) {
        throw new Error(`HEAD changed-file count mismatch: expected ${expected} from parent git diff-tree, hub reported ${reported}`);
      }
      return { expected, reported, childId, resultPath: result.details.resultPath };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('live hub delegation smoke independently counts files changed by HEAD', async () => {
  const result = await runSmoke();
  assert.equal(result.reported, result.expected);
  assert.match(result.childId, /^head-count-smoke\.verifier-/);
});

test('live hub delegation smoke reports count mismatches clearly', async () => {
  await assert.rejects(() => runSmoke('mismatch'), /HEAD changed-file count mismatch: expected \d+ from parent git diff-tree, hub reported \d+/);
});

test('live hub delegation smoke reports missing delegation evidence and hub failures clearly', async () => {
  await assert.rejects(() => runSmoke('no-digest'), /Missing delegation evidence/);
  await assert.rejects(() => runSmoke('failure'), /Agent Fleet hub delegation failed: error/);
});

test('live hub delegation smoke reports bounded hub timeouts clearly', async () => {
  await assert.rejects(() => runSmoke('hang'), /Agent Fleet hub delegation timed out: turn_timeout|tool_timeout/);
});
