import "../../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JEV_MODEL, type JevTransport } from "./jev.ts";
import { runSystem1Demo } from "./demo.ts";

const validConfig = {
  version: 1,
  mode: "auto",
  provider: "typesafe",
  model: JEV_MODEL,
  apiKeyEnv: "TYPESAFE_API_KEY",
};

function workspace(t: TestContext): string {
  const ws = mkdtempSync(join(tmpdir(), "af-system1-demo-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "agent-fleet.json"), JSON.stringify({
    schemaVersion: 1,
    preset: "default",
    features: { system1: true },
  }));
  writeFileSync(join(ws, ".ai", "system1.json"), JSON.stringify(validConfig));
  return ws;
}

function validResponse(): string {
  return JSON.stringify({
    model: JEV_MODEL,
    answers: {
      route: { type: "choice", choice: "review", probabilities: { accept: 0.25, review: 0.75 }, confidence: 0.7 },
      urgent: { type: "noul", noul: 0.4 },
      severity: { type: "score", score: 1.1, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 }, confidence: 0.65 },
    },
    usage: { input_tokens: 12, output_tokens: 7 },
  });
}

test("default demo is offline readiness and never creates provider traffic", async (t) => {
  const ws = workspace(t);
  let calls = 0;
  const lines: string[] = [];
  const result = await runSystem1Demo({
    argv: [], cwd: ws, env: { TYPESAFE_API_KEY: "private-value" },
    transport: async () => { calls += 1; throw new Error("must stay offline"); },
    write: (line) => lines.push(line),
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { mode: "offline", status: "ready" });
  assert.equal(lines.join("\n").includes("private-value"), false);
});

test("--live without a current key skips and makes no transport call", async (t) => {
  const ws = workspace(t);
  let calls = 0;
  const result = await runSystem1Demo({
    argv: ["--live"], cwd: ws, env: {},
    transport: async () => { calls += 1; throw new Error("must not run"); },
    write: () => {},
  });
  assert.deepEqual(result, { mode: "live", status: "skipped", reason: "missing_key" });
  assert.equal(calls, 0);
});

test("explicit --live sends only embedded Bulgarian/English synthetic fields and reports bounded metadata", async (t) => {
  const ws = workspace(t);
  let observedBody: unknown;
  const transport: JevTransport = async (request) => {
    observedBody = JSON.parse(request.body.toString("utf8"));
    assert.equal(request.headers.authorization, "Bearer private-value");
    return { status: 200, headers: {}, body: validResponse() };
  };
  const lines: string[] = [];
  const result = await runSystem1Demo({
    argv: ["--live"], cwd: ws, env: { TYPESAFE_API_KEY: "private-value" }, transport,
    write: (line) => lines.push(line),
  });

  assert.equal(result.mode, "live");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.model, JEV_MODEL);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(result.uncertainty.length, 3);
  assert.equal(typeof result.latencyMs, "number");
  const wire = JSON.stringify(observedBody);
  assert.match(wire, /Синтетичен/);
  assert.match(wire, /Synthetic/);
  assert.equal(wire.includes(ws), false);
  assert.equal(wire.includes("private-value"), false);
  assert.equal(lines.join("\n").includes("private-value"), false);
});
