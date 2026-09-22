import "../../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderEvaluation,
  System1Provider,
  System1Question,
} from "./contracts.ts";
import { createSystem1Runtime, createSystem1Service } from "./service.ts";

const questions: System1Question[] = [
  {
    id: "route",
    type: "choice",
    instructions: "Choose a route",
    options: { safe: "Safe", review: "Needs review" },
  },
  {
    id: "urgent",
    type: "predicate",
    instructions: "Is it urgent?",
  },
];

function validEvaluation(): ProviderEvaluation {
  return {
    answers: [
      {
        questionId: "route",
        type: "choice",
        value: "safe",
        uncertainty: {
          provenance: "provider",
          distribution: { safe: 0.8, review: 0.2 },
          confidence: 0.7,
        },
      },
      {
        questionId: "urgent",
        type: "predicate",
        probabilityTrue: 0.25,
        uncertainty: { provenance: "provider", confidence: 0.6 },
      },
    ],
    metadata: {
      provider: "fake",
      requestedModel: "fake-1",
      returnedModel: "fake-1",
      questionSetVersion: "v1",
      latencyMs: 4,
      attempts: 1,
      usage: { inputTokens: 7, outputTokens: 2 },
    },
  };
}

function fakeProvider(
  evaluate: System1Provider["evaluate"] = async () => ({
    status: "ok",
    evaluation: validEvaluation(),
  }),
): System1Provider {
  return {
    name: "fake",
    model: "fake-1",
    capabilities: [
      "choice",
      "predicate",
      "ordinal",
      "distribution",
      "probability_true",
      "provider_confidence",
    ],
    evaluate,
  };
}

const request = {
  state: "synthetic state",
  questions,
  questionSetVersion: "v1",
};

test("runtime factory keeps credentials private and skipped paths make no transport calls", async () => {
  const config = { version: 1, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY" } as const;
  const env = { TYPESAFE_API_KEY: "private-test-value", KEEP: "same" };
  const before = structuredClone(env);
  const ready = createSystem1Runtime({
    selected: true, config, env,
    transport: async () => { throw new Error("transport must not run during construction"); },
  });
  assert.deepEqual(ready.readiness, { status: "ready" });
  assert.deepEqual(env, before);
  assert.equal(JSON.stringify(ready.readiness).includes(env.TYPESAFE_API_KEY), false);

  let calls = 0;
  const skipped = createSystem1Runtime({
    selected: true, config, env: {},
    transport: async () => { calls += 1; throw new Error("must not run"); },
  });
  assert.deepEqual(await skipped.service.evaluate(request), { status: "skipped", reason: "missing_key" });
  assert.equal(calls, 0);
});

test("disabled and missing-key paths skip without invoking the provider", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => {
    calls += 1;
    throw new Error("provider must not run");
  });

  for (const reason of ["disabled", "missing_config", "missing_key"] as const) {
    const service = createSystem1Service({
      availability: { status: "skipped", reason },
      provider,
    });
    assert.deepEqual(await service.evaluate(request), { status: "skipped", reason });
  }
  assert.equal(calls, 0);
});

test("base capabilities allow answers without optional distributions", async () => {
  let calls = 0;
  const evaluation = validEvaluation();
  evaluation.answers[0]!.uncertainty = { provenance: "provider" };
  const provider = fakeProvider(async () => {
    calls += 1;
    return { status: "ok", evaluation };
  });
  provider.capabilities = ["choice", "predicate"];

  const result = await createSystem1Service({ provider }).evaluate(request);
  assert.equal(result.status, "ok");
  assert.equal(calls, 1);
  if (result.status !== "ok") return;
  assert.deepEqual(result.evaluation.answers[0]!.uncertainty, { provenance: "provider" });
});

test("unsupported required capability is explicit and makes no provider call", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => {
    calls += 1;
    throw new Error("provider must not run");
  });
  provider.capabilities = ["choice", "predicate"];
  const service = createSystem1Service({ provider });

  assert.deepEqual(
    await service.evaluate({
      ...request,
      requiredCapabilities: ["distribution", "provider_confidence"],
    }),
    {
      status: "unsupported",
      missingCapabilities: ["distribution", "provider_confidence"],
    },
  );
  assert.equal(calls, 0);
});

test("explicitly required uncertainty must be present on every applicable returned answer", async (t) => {
  for (const [name, capability, remove] of [
    ["choice distribution", "distribution", (value: ProviderEvaluation) => { delete value.answers[0]!.uncertainty.distribution; }],
    ["choice confidence", "provider_confidence", (value: ProviderEvaluation) => { delete value.answers[0]!.uncertainty.confidence; }],
    ["predicate confidence", "provider_confidence", (value: ProviderEvaluation) => { delete value.answers[1]!.uncertainty.confidence; }],
  ] as const) {
    await t.test(name, async () => {
      const evaluation = structuredClone(validEvaluation());
      remove(evaluation);
      const result = await createSystem1Service({
        provider: fakeProvider(async () => ({ status: "ok", evaluation })),
      }).evaluate({ ...request, requiredCapabilities: [capability] });
      assert.deepEqual(result, { status: "unavailable", reason: "invalid_response" });
    });
  }
});

test("valid provider-neutral batches preserve answers and uncertainty provenance", async () => {
  const result = await createSystem1Service({ provider: fakeProvider() }).evaluate(request);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.evaluation, validEvaluation());
  assert.equal(result.evaluation.answers[0]?.uncertainty.provenance, "provider");
});

test("the complete provider answer batch is validated before becoming ok", async (t) => {
  const cases: Array<[string, (value: ProviderEvaluation) => void]> = [
    ["missing answer", (value) => value.answers.pop()],
    ["extra answer", (value) => value.answers.push({ ...value.answers[1]!, questionId: "extra" })],
    ["duplicate answer", (value) => value.answers.push({ ...value.answers[1]! })],
    ["mistyped answer", (value) => Object.assign(value.answers[0]!, { type: "predicate", probabilityTrue: 0.5 })],
    ["invalid probability", (value) => Object.assign(value.answers[1]!, { probabilityTrue: Number.NaN })],
    ["invalid optional distribution", (value) => Object.assign(value.answers[0]!.uncertainty, { distribution: { safe: 1.1, review: 0 } })],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = structuredClone(validEvaluation());
      mutate(value);
      const service = createSystem1Service({
        provider: fakeProvider(async () => ({ status: "ok", evaluation: value })),
      });
      assert.deepEqual(await service.evaluate(request), {
        status: "unavailable",
        reason: "invalid_response",
      });
    });
  }
});

test("invalid requests and pre-cancelled requests never invoke the provider", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => {
    calls += 1;
    throw new Error("provider must not run");
  });
  const service = createSystem1Service({ provider });

  assert.deepEqual(
    await service.evaluate({ ...request, questions: [...questions, questions[0]!] }),
    { status: "unavailable", reason: "invalid_request" },
  );

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await service.evaluate({ ...request, signal: controller.signal }), {
    status: "cancelled",
  });
  assert.equal(calls, 0);
});

test("provider exceptions are contained without exposing their messages", async () => {
  const secret = "super-secret";
  const service = createSystem1Service({
    provider: fakeProvider(async () => {
      throw new Error(`network failed with ${secret}`);
    }),
  });
  const result = await service.evaluate(request);
  assert.deepEqual(result, { status: "unavailable", reason: "network" });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
