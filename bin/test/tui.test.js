import test from "node:test";
import assert from "node:assert/strict";
import { chooseSetup } from "../lib/tui.js";

const manifest = {
  presets: { default: {}, full: {} },
  features: {
    voice: { stability: "stable" },
    "chatgpt-client": { stability: "experimental" },
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
  assert.deepEqual(value.result, { cancelled: false, preset: "default", features: [], allFeaturesSnapshot: false, changed: false });
  assert.match(value.text, /voice \(stable\)/);
  assert.match(value.text, /chatgpt-client \(experimental\)/);

  value = await run(["1", "voice"]);
  assert.deepEqual(value.result, { cancelled: false, preset: "default", features: ["voice"], allFeaturesSnapshot: false, changed: true });

  value = await run(["2", ""]);
  assert.deepEqual(value.result, { cancelled: false, preset: "full", features: [], allFeaturesSnapshot: false, changed: true });
  assert.doesNotMatch(value.text, /Continue to the exact plan/);
});

test("TUI keeps existing desired state for blank input and retries unknown identifiers", async () => {
  const currentDesired = { preset: "full", features: { voice: true, "chatgpt-client": false } };
  const value = await run(["", "unknown", ""], currentDesired);
  assert.deepEqual(value.result, { cancelled: false, preset: "full", features: ["voice"], allFeaturesSnapshot: false, changed: false });
  assert.match(value.text, /Unknown feature "unknown".*Try again/i);
});

test("TUI EOF or explicit cancellation writes no decision", async () => {
  assert.deepEqual((await run([null])).result, { cancelled: true, reason: "EOF" });
  assert.deepEqual((await run(["cancel"])).result, { cancelled: true, reason: "cancel" });
  assert.deepEqual((await run(["1", null])).result, { cancelled: true, reason: "EOF" });
});

test("third choice snapshots every available feature and shows dependency summaries", async () => {
  const value = await run(["3", ""]);
  assert.equal(value.result.preset, "full");
  assert.equal(value.result.allFeaturesSnapshot, true);
  assert.deepEqual(value.result.features, ["chatgpt-client", "voice"]);
  assert.match(value.text, /\[3\] Full \+ all features/);
  assert.match(value.text, /Selected features: chatgpt-client \(experimental\), voice \(stable\)/);
});

test("invalid answers retry instead of cancelling", async () => {
  const value = await run(["wat", "1", "bogus", "none"]);
  assert.match(value.text, /Invalid preset/);
  assert.match(value.text, /Unknown feature "bogus"/);
  assert.equal(value.result.cancelled, false);
});
