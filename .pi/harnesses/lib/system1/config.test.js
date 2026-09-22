import "../../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEM1_CONFIG_RELATIVE_PATH,
  SYSTEM1_CONFIG_VERSION,
  resolveSystem1Readiness,
  validateSystem1Config,
} from "./config.js";
const valid = {
  version: 1,
  mode: "auto",
  provider: "typesafe",
  model: "jev-1.13.0",
  apiKeyEnv: "TYPESAFE_API_KEY",
};

test("validates only the phase-0 System 1 configuration contract", () => {
  assert.equal(SYSTEM1_CONFIG_RELATIVE_PATH, ".ai/system1.json");
  assert.equal(SYSTEM1_CONFIG_VERSION, 1);
  assert.deepEqual(validateSystem1Config(valid), { ok: true, config: valid });
  for (const value of [
    null,
    {},
    { mode: valid.mode, provider: valid.provider, model: valid.model, apiKeyEnv: valid.apiKeyEnv },
    { ...valid, version: 2 },
    { ...valid, mode: "on" },
    { ...valid, provider: "other" },
    { ...valid, model: "jev-latest" },
    { ...valid, apiKeyEnv: "OTHER_KEY" },
    { ...valid, extra: true },
  ]) {
    assert.deepEqual(validateSystem1Config(value), { ok: false });
  }
});

test("readiness follows selection, off precedence, config, and nonempty caller environment", () => {
  const cases = [
    ["unselected", { selected: false, config: { nonsense: true }, env: {} }, { status: "skipped", reason: "disabled" }],
    ["off wins over invalid fields", { selected: true, config: { mode: "off", nonsense: true }, env: {} }, { status: "skipped", reason: "disabled" }],
    ["missing config", { selected: true, config: undefined, env: {} }, { status: "skipped", reason: "missing_config" }],
    ["invalid active config", { selected: true, config: { ...valid, model: "wrong" }, env: {} }, { status: "unavailable", reason: "invalid_config" }],
    ["missing key", { selected: true, config: valid, env: {} }, { status: "skipped", reason: "missing_key" }],
    ["empty key", { selected: true, config: valid, env: { TYPESAFE_API_KEY: "  " } }, { status: "skipped", reason: "missing_key" }],
    ["ready", { selected: true, config: valid, env: { TYPESAFE_API_KEY: "present" } }, { status: "ready" }],
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(resolveSystem1Readiness(input), expected, name);
  }
});

test("readiness does not mutate or expose caller environment values", () => {
  const env = { TYPESAFE_API_KEY: "private-test-value", KEEP: "same" };
  const before = structuredClone(env);
  const readiness = resolveSystem1Readiness({ selected: true, config: valid, env });
  assert.deepEqual(readiness, { status: "ready" });
  assert.deepEqual(env, before);
  assert.equal(JSON.stringify(readiness).includes(env.TYPESAFE_API_KEY), false);
});
