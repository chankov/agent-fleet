import test from "node:test";
import assert from "node:assert/strict";
import { chooseSetup } from "../lib/tui.js";

const manifest = {
  presets: { default: {}, full: {} },
  features: {
    voice: { stability: "stable" },
    "codex-remote": { stability: "experimental" },
  },
};
const run = (answers, currentDesired = null) => {
  let text = "";
  return chooseSetup({
    output: { write: (line) => { text += line; } },
    readLine: async () => answers.shift() ?? null,
    manifest,
    currentDesired,
  }).then((result) => ({ result, text }));
};

test("TUI offers labelled features and accepts Default, a valid feature, and Full without a pre-plan confirmation", async () => {
  let value = await run(["1", ""]);
  assert.deepEqual(value.result, { cancelled: false, preset: "default", features: [], changed: false });
  assert.match(value.text, /voice \(stable\)/);
  assert.match(value.text, /codex-remote \(experimental\)/);

  value = await run(["1", "voice"]);
  assert.deepEqual(value.result, { cancelled: false, preset: "default", features: ["voice"], changed: true });

  value = await run(["2", ""]);
  assert.deepEqual(value.result, { cancelled: false, preset: "full", features: [], changed: true });
  assert.doesNotMatch(value.text, /Continue to the exact plan/);
});

test("TUI keeps existing desired state for blank input and retries unknown identifiers", async () => {
  const currentDesired = { preset: "full", features: { voice: true, "codex-remote": false } };
  const value = await run(["", "unknown", ""], currentDesired);
  assert.deepEqual(value.result, { cancelled: false, preset: "full", features: ["voice"], changed: false });
  assert.match(value.text, /Unknown feature "unknown".*Try again/i);
});

test("TUI EOF or explicit cancellation writes no decision", async () => {
  assert.deepEqual((await run([null])).result, { cancelled: true });
  assert.deepEqual((await run(["cancel"])).result, { cancelled: true });
  assert.deepEqual((await run(["1", null])).result, { cancelled: true });
});
