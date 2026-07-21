import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPiAgent } from '../.pi/harnesses/agent-hub/spawn.ts';

function createFakePi(tmp, capturePath) {
  const fakePiPath = join(tmp, 'pi');
  writeFileSync(fakePiPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.env.FAKE_PI_MODE || 'normal';
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const start = (id, toolName = 'read') => emit({ type: 'tool_execution_start', toolCallId: id, toolName, args: { path: '/disk/' + id } });
const end = (id, toolName = 'read') => emit({ type: 'tool_execution_end', toolCallId: id, toolName });
const done = () => { emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'FAKE OK' } }); emit({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 1, output: 2 } }] }); };
if (mode === 'normal') {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { stdin += chunk; });
  process.stdin.on('end', () => { fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }), 'utf8'); done(); });
} else if (mode === 'long-activity') {
  setTimeout(done, 90);
} else if (mode === 'parallel') {
  start('completed'); start('hanging');
  setTimeout(() => end('completed'), 10);
  setTimeout(() => start('hanging'), 20); // duplicate must not extend its deadline
  setInterval(() => {}, 1000);
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => {}); start('stubborn'); setInterval(() => {}, 1000);
} else if (mode === 'each-read-only-tool') {
  start('watch', process.env.FAKE_PI_TOOL_NAME); setInterval(() => {}, 1000);
} else if (mode === 'leader-exits-first') {
  const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'inherit' });
  fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
  start('orphan-check'); setTimeout(() => process.exit(0), 10);
} else if (mode === 'stubborn-descendant') {
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.FAKE_CHILD_PID, String(process.pid)); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('message', () => start('stubborn-descendant'));
} else if (mode === 'close-never') {
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); fs.writeFileSync(process.env.FAKE_CHILD_PID, String(process.pid)); process.send('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  process.on('SIGTERM', () => {}); child.once('message', () => start('close-never')); setInterval(() => {}, 1000);
} else if (mode === 'cancel') {
  start('cancelled'); setInterval(() => {}, 1000);
} else if (mode === 'hang-no-tool') {
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } });
  setInterval(() => {}, 1000);
} else if (mode === 'tool-errors') {
  start('e1', 'bash'); emit({ type: 'tool_execution_end', toolCallId: 'e1', toolName: 'bash', isError: true });
  start('e2', 'bash'); emit({ type: 'tool_execution_end', toolCallId: 'e2', toolName: 'bash', result: { isError: false } });
  start('e3', 'bash'); end('e3', 'bash');
  done();
}
`);
  chmodSync(fakePiPath, 0o755);
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} survived bounded group cleanup`);
}

function options(tmp, env = {}, watchdog = undefined) {
  return {
    model: 'fake/model', tools: 'read,grep', thinking: 'off', appendSystemPrompt: 'fake system',
    sessionFile: join(tmp, 'session.jsonl'), prompt: 'prompt',
    env: { ...env, PATH: `${tmp}:${process.env.PATH ?? ''}` },
    ...(watchdog ? { toolWatchdog: watchdog } : {}),
  };
}

test('spawnPiAgent sends the prompt through stdin instead of an unsupported -- separator', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-spawn-'));
  try {
    const capturePath = join(tmp, 'capture.json');
    createFakePi(tmp, capturePath);
    const prompt = '-- this prompt starts like a CLI option and must still be user input';
    const result = await spawnPiAgent({ ...options(tmp, { FAKE_PI_CAPTURE: capturePath }), prompt, extensions: ['damage-control.ts', 'delegate.ts'], resume: true });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'FAKE OK');
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.equal(capture.stdin, prompt);
    assert.ok(!capture.argv.includes('--'), 'pi does not accept a standalone -- option separator');
    assert.ok(!capture.argv.includes(prompt), 'prompt should not be passed as an argv option/positional');
    assert.deepEqual(capture.argv, ['--mode', 'json', '-p', '--no-extensions', '-e', 'damage-control.ts', '-e', 'delegate.ts', '--model', 'fake/model', '--tools', 'read,grep', '--thinking', 'off', '--append-system-prompt', 'fake system', '--session', join(tmp, 'session.jsonl'), '-c']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('watchdog supervises every read-only research tool name', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-all-tools-'));
  try {
    createFakePi(tmp);
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'each-read-only-tool', FAKE_PI_TOOL_NAME: toolName }, { timeoutMs: 20, termGraceMs: 10, settleGraceMs: 20 }));
      assert.equal(result.termination?.reason, 'tool_timeout');
      assert.equal(result.termination?.tool?.toolName, toolName);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('watchdog independently clears completed calls and duplicate starts never extend a hanging call', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-watchdog-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'parallel' }, { timeoutMs: 45, termGraceMs: 20, settleGraceMs: 20 }));
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.tool?.toolCallId, 'hanging');
    assert.equal(result.termination?.tool?.toolName, 'read');
    assert.equal(typeof result.termination?.confirmed, 'boolean', 'bounded settlement reports confirmation state');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('watchdog does not impose a whole-agent deadline when no tool is active', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-long-activity-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'long-activity' }, { timeoutMs: 20, termGraceMs: 10, settleGraceMs: 10 }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.termination, undefined);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('watchdog escalates stubborn processes and settles within a bounded grace period', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-stubborn-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'stubborn' }, { timeoutMs: 20, termGraceMs: 20, settleGraceMs: 20 }));
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.escalated, true);
    assert.equal(typeof result.termination?.confirmed, 'boolean', 'final timer may settle before close and reports that fact');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('final settlement resolves without close and reports unconfirmed termination', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-close-never-'));
  let orphanPid;
  try {
    const childPidPath = join(tmp, 'orphan.pid');
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'close-never', FAKE_CHILD_PID: childPidPath }, { timeoutMs: 20, termGraceMs: 20, settleGraceMs: 20 }));
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.escalated, true);
    assert.equal(result.termination?.confirmed, false);
    orphanPid = Number(readFileSync(childPidPath, 'utf8'));
  } finally {
    if (orphanPid) try { process.kill(orphanPid, 'SIGKILL'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('owned group cleanup kills a descendant after its leader exits first', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-leader-exits-'));
  try {
    const childPidPath = join(tmp, 'child.pid');
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'leader-exits-first', FAKE_CHILD_PID: childPidPath }, { timeoutMs: 35, termGraceMs: 20, settleGraceMs: 20 }));
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.ok(existsSync(childPidPath));
    const pid = Number(readFileSync(childPidPath, 'utf8'));
    await waitForProcessExit(pid);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('watchdog escalates through an owned group to kill stubborn descendants', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-stubborn-descendant-'));
  try {
    const childPidPath = join(tmp, 'child.pid');
    createFakePi(tmp);
    const result = await spawnPiAgent(options(tmp, { FAKE_PI_MODE: 'stubborn-descendant', FAKE_CHILD_PID: childPidPath }, { timeoutMs: 20, termGraceMs: 20, settleGraceMs: 20 }));
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.escalated, true);
    const pid = Number(readFileSync(childPidPath, 'utf8'));
    await waitForProcessExit(pid);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('tool timeout wins a later cancellation lifecycle race', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-timeout-race-'));
  try {
    createFakePi(tmp);
    const controller = new AbortController();
    const pending = spawnPiAgent(
      { ...options(tmp, { FAKE_PI_MODE: 'cancel' }, { timeoutMs: 20, termGraceMs: 30, settleGraceMs: 30 }), signal: controller.signal },
      { onToolStart: () => setTimeout(() => controller.abort(), 40) },
    );
    const result = await pending;
    assert.equal(result.termination?.reason, 'tool_timeout');
    assert.equal(result.termination?.tool?.toolCallId, 'cancelled');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('caller cancellation uses bounded cleanup and remains distinct from tool timeout', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-cancel-'));
  try {
    createFakePi(tmp);
    const controller = new AbortController();
    const pending = spawnPiAgent({ ...options(tmp, { FAKE_PI_MODE: 'cancel' }, { timeoutMs: 200, termGraceMs: 20, settleGraceMs: 20 }), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    assert.equal(result.termination?.reason, 'cancelled');
    assert.equal(result.termination?.tool, undefined);
    assert.equal(result.termination?.confirmed, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('turn deadline terminates a hanging run even when no watched tool is active', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-turn-deadline-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent({
      ...options(tmp, { FAKE_PI_MODE: 'hang-no-tool' }),
      turnDeadlineMs: 400,
      toolWatchdog: { timeoutMs: null, termGraceMs: 20, settleGraceMs: 20 },
    });
    assert.equal(result.termination?.reason, 'turn_timeout');
    assert.equal(result.termination?.tool, undefined);
    assert.equal(result.output, 'partial ');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('turn deadline leaves a fast normal exit untouched', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-turn-fast-'));
  try {
    const capture = join(tmp, 'capture.json');
    createFakePi(tmp, capture);
    const result = await spawnPiAgent({
      ...options(tmp, { FAKE_PI_MODE: 'normal', FAKE_PI_CAPTURE: capture }),
      turnDeadlineMs: 5_000,
    });
    assert.equal(result.termination, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'FAKE OK');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('tool timeout wins classification when it fires before the turn deadline', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-turn-race-'));
  try {
    createFakePi(tmp);
    const result = await spawnPiAgent({
      ...options(tmp, { FAKE_PI_MODE: 'cancel' }, { timeoutMs: 20, termGraceMs: 30, settleGraceMs: 30 }),
      turnDeadlineMs: 2_000,
    });
    assert.equal(result.termination?.reason, 'tool_timeout');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('onControl terminate classifies an external drift stop and preserves partial output', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-drift-stop-'));
  try {
    createFakePi(tmp);
    let control;
    const resultPromise = spawnPiAgent({
      ...options(tmp, { FAKE_PI_MODE: 'hang-no-tool' }),
      toolWatchdog: { timeoutMs: null, termGraceMs: 20, settleGraceMs: 20 },
    }, {
      onControl: c => { control = c; },
      onTextDelta: () => setTimeout(() => control.terminate('drift_stop'), 30),
    });
    const result = await resultPromise;
    assert.equal(result.termination?.reason, 'drift_stop');
    assert.equal(result.output, 'partial ');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('onToolEnd surfaces error flags from either event shape and omits unknown', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-tool-errors-'));
  try {
    createFakePi(tmp);
    const seen = [];
    const result = await spawnPiAgent(
      options(tmp, { FAKE_PI_MODE: 'tool-errors' }),
      { onToolEnd: (tool, _id, isError) => seen.push([tool, isError]) },
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(seen, [['bash', true], ['bash', false], ['bash', undefined]]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
