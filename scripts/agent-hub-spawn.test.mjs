import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPiAgent } from '../.pi/harnesses/agent-hub/spawn.ts';

function createFakePi(tmp, capturePath) {
  const fakePiPath = join(tmp, 'pi');
  writeFileSync(fakePiPath, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }), 'utf8');
  process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'FAKE OK' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { usage: { input: 1, output: 2 } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 1, output: 2 } }] }) + '\\n');
});
`);
  chmodSync(fakePiPath, 0o755);
}

test('spawnPiAgent sends the prompt through stdin instead of an unsupported -- separator', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-spawn-'));
  try {
    const capturePath = join(tmp, 'capture.json');
    createFakePi(tmp, capturePath);

    const prompt = '-- this prompt starts like a CLI option and must still be user input';
    const result = await spawnPiAgent({
      model: 'fake/model',
      tools: 'read,grep',
      thinking: 'off',
      appendSystemPrompt: 'fake system',
      sessionFile: join(tmp, 'session.jsonl'),
      prompt,
      extensions: ['damage-control.ts', 'delegate.ts'],
      resume: true,
      env: {
        FAKE_PI_CAPTURE: capturePath,
        PATH: `${tmp}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'FAKE OK');

    const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.equal(capture.stdin, prompt);
    assert.ok(!capture.argv.includes('--'), 'pi does not accept a standalone -- option separator');
    assert.ok(!capture.argv.includes(prompt), 'prompt should not be passed as an argv option/positional');
    assert.deepEqual(capture.argv, [
      '--mode', 'json',
      '-p',
      '--no-extensions',
      '-e', 'damage-control.ts',
      '-e', 'delegate.ts',
      '--model', 'fake/model',
      '--tools', 'read,grep',
      '--thinking', 'off',
      '--append-system-prompt', 'fake system',
      '--session', join(tmp, 'session.jsonl'),
      '-c',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
