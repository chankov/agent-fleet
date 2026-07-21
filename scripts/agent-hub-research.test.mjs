import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPiAgent } from '../.pi/harnesses/agent-hub/spawn.ts';
import { researchTerminationOutcome, researchWatchdogSpawnOptions } from '../.pi/harnesses/agent-hub/research-watchdog.ts';

function createFakePi(tmp) {
  const path = join(tmp, 'pi');
  writeFileSync(path, `#!/usr/bin/env node
const event = e => process.stdout.write(JSON.stringify(e) + '\\n');
event({ type: 'tool_execution_start', toolCallId: 'research-read', toolName: 'read', args: { path: '/disk/research' } });
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o755);
}

test('native research runtime policy supervises its tool and maps it to tool_timeout lifecycle output', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-research-runtime-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent({
      model: 'fake/model', tools: 'read,grep,find,ls', thinking: 'off', appendSystemPrompt: '',
      sessionFile: join(tmp, 'session.jsonl'), prompt: 'research',
      env: { PATH: `${tmp}:${process.env.PATH ?? ''}` },
      ...researchWatchdogSpawnOptions(20),
    });
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.tool?.toolCallId, 'research-read');
    const outcome = researchTerminationOutcome(7, result.termination);
    assert.equal(outcome.status, 'tool_timeout');
    assert.equal(outcome.lastWork, 'tool_timeout: read (research-read)');
    assert.equal(outcome.exitCode, 124);
    assert.match(outcome.output, /toolCallId=research-read/);
    assert.match(outcome.output, /terminationConfirmed=/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('native research policy preserves explicit off/null', () => {
  const policy = researchWatchdogSpawnOptions(null);
  assert.equal(policy.toolWatchdog.timeoutMs, null);
  assert.equal(policy.detached, true);
});
