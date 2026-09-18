import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundToolResult, boundedOutputEnabled } from "./bounded-output.ts";
import { readback } from "./deterministic-fs.ts";
import { spawnPiAgent } from "./spawn.ts";
import { PROFILE_ENV } from "./policy/profile-runtime.ts";

const active = (assist: any) => ({ [PROFILE_ENV]: JSON.stringify({ name: "local", profile: { version: 2, defaults: { model: "local/m" }, "allowed-models": ["local/m"], assist } }) });

test("T5 child bounded-output profile consumption is independent across all four flag combinations", () => {
 assert.equal(boundedOutputEnabled({}), false);
 for (const [deterministicTools, boundedOutput, expected] of [
  [false, false, false],
  [true, false, false],
  [false, true, true],
  [true, true, true],
 ] as const) {
  assert.equal(boundedOutputEnabled(active({ "deterministic-tools": deterministicTools, "bounded-output": boundedOutput })), expected);
 }
});

test("T5 child tool result bounds grep/find/ls the same as read", () => {
 const dir = mkdtempSync(join(tmpdir(), "fleet-tool-bound-tools-"));
 try {
  const original = "y".repeat(70 * 1024);
  for (const toolName of ["grep", "find", "ls"]) {
   const changed: any = boundToolResult({ toolName, toolCallId: toolName, content: [{ type: "text", text: original }], details: {} }, dir);
   assert.ok(Buffer.byteLength(changed.content[0].text, "utf8") <= 64 * 1024, toolName);
   assert.deepEqual(readback({ handle: changed.details.boundedOutput.handle, allowedRoot: dir, boundedOutput: false }).content, Buffer.from(original));
  }
  assert.equal(boundToolResult({ toolName: "write", content: [{ type: "text", text: original }] }, dir), undefined);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T5 child tool result is bounded before model continuation and original is retrievable", () => {
 const dir = mkdtempSync(join(tmpdir(), "fleet-tool-bound-"));
 try {
  const original = "🙂".repeat(20_000);
  const changed: any = boundToolResult({ toolName: "read", toolCallId: "c1", content: [{ type: "text", text: original }], details: {} }, dir);
  assert.ok(Buffer.byteLength(changed.content[0].text, "utf8") <= 64 * 1024);
  assert.equal(changed.details.boundedOutput.totalBytes, Buffer.byteLength(original));
  assert.deepEqual(readback({ handle: changed.details.boundedOutput.handle, allowedRoot: dir, boundedOutput: false }).content, Buffer.from(original));
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T5 opt-in off leaves actual child stdout unchanged", async () => {
 const dir = mkdtempSync(join(tmpdir(), "fleet-child-off-"));
 try {
  const text = "x".repeat(70 * 1024);
  writeFileSync(join(dir, "pi"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:${JSON.stringify(text)}}})+'\\n');`, { mode: 0o755 });
  const result = await spawnPiAgent({ model: "local/m", tools: "read", thinking: "off", sessionFile: join(dir, "session"), prompt: "x", env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(result.output, text); assert.equal(result.boundedOutput, undefined);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T5 actual child stdout transport is bounded with full-output retrieval", async () => {
 const dir = mkdtempSync(join(tmpdir(), "fleet-child-bound-"));
 try {
  const text = "🙂".repeat(20_000);
  writeFileSync(join(dir, "pi"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:${JSON.stringify(text)}}})+'\\n');`, { mode: 0o755 });
  const result = await spawnPiAgent({ model: "local/m", tools: "read", thinking: "off", sessionFile: join(dir, "session"), prompt: "x", env: { PATH: `${dir}:${process.env.PATH}` }, boundedOutputDir: join(dir, "retained") });
  assert.equal(result.exitCode, 0); assert.equal(result.boundedOutput?.truncated, true);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 64 * 1024); assert.equal(result.output.includes("�"), false);
  assert.deepEqual(readFileSync(result.boundedOutput!.contentPath), Buffer.from(text));
  assert.deepEqual(readback({ handle: result.boundedOutput!.handle, allowedRoot: join(dir, "retained"), boundedOutput: false }).content, Buffer.from(text));
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
