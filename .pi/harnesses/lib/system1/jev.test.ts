import "../../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { EvaluateRequest } from "./contracts.ts";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  createJevProvider,
  type JevHttpRequest,
  type JevHttpResponse,
  type JevTransport,
} from "./jev.ts";
import { createSystem1Service } from "./service.ts";

const request: EvaluateRequest = {
  state: { message: "Synthetic input only" },
  questionSetVersion: "fixture-v1",
  questions: [
    {
      id: "route",
      type: "choice",
      instructions: "Choose a route",
      options: { accept: "Safe", review: "Needs review" },
    },
    {
      id: "urgent",
      type: "predicate",
      instructions: "Is it urgent?",
      criteria: { true: "Urgent", false: "Not urgent" },
    },
    {
      id: "severity",
      type: "ordinal",
      instructions: "Rate severity",
      levels: ["low", "medium", "high"],
    },
  ],
};

function validWireResponse() {
  return {
    model: JEV_MODEL,
    answers: {
      route: {
        type: "choice",
        choice: "accept",
        probabilities: { accept: 0.8, review: 0.2 },
        confidence: 0.7,
      },
      urgent: { type: "noul", noul: 0.25 },
      severity: {
        type: "score",
        score: 1.2,
        legend: { "0": "low", "1": "medium", "2": "high" },
        probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
        confidence: 0.65,
      },
    },
    usage: { input_tokens: 21, output_tokens: 8 },
  };
}

function response(
  status: number,
  body: string | Uint8Array | AsyncIterable<Uint8Array> = "",
  headers: Record<string, string> = {},
): JevHttpResponse {
  return { status, headers, body };
}

function serviceWith(transport: JevTransport, extra = {}) {
  return createSystem1Service({
    provider: createJevProvider({ apiKey: "test-key", transport, ...extra }),
  });
}

test("does not promise provider confidence because predicate responses do not carry it", async () => {
  let calls = 0;
  const service = serviceWith(async () => {
    calls += 1;
    return response(200, JSON.stringify(validWireResponse()));
  });

  assert.deepEqual(await service.evaluate({
    ...request,
    requiredCapabilities: ["provider_confidence"],
  }), {
    status: "unsupported",
    missingCapabilities: ["provider_confidence"],
  });
  assert.equal(calls, 0);
});

test("maps all Fleet primitives to the verified Jev wire contract and preserves metadata", async () => {
  let observed: JevHttpRequest | undefined;
  const service = serviceWith(async (httpRequest) => {
    observed = httpRequest;
    return response(200, JSON.stringify(validWireResponse()));
  });

  const result = await service.evaluate(request);
  assert.equal(result.status, "ok");
  assert.ok(observed);
  assert.equal(observed.url, JEV_ENDPOINT);
  assert.equal(observed.method, "POST");
  assert.equal(observed.headers.authorization, "Bearer test-key");
  assert.equal(observed.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(observed.body.toString("utf8")), {
    state: request.state,
    model: JEV_MODEL,
    questions: {
      route: {
        type: "choice",
        instructions: "Choose a route",
        criteria: { accept: "Safe", review: "Needs review" },
      },
      urgent: {
        type: "noul",
        instructions: "Is it urgent?",
        criteria: { true: "Urgent", false: "Not urgent" },
      },
      severity: {
        type: "score",
        instructions: "Rate severity",
        criteria: ["low", "medium", "high"],
      },
    },
  });

  if (result.status !== "ok") return;
  assert.equal(result.evaluation.metadata.requestedModel, JEV_MODEL);
  assert.equal(result.evaluation.metadata.returnedModel, JEV_MODEL);
  assert.deepEqual(result.evaluation.metadata.usage, { inputTokens: 21, outputTokens: 8 });
  assert.deepEqual(result.evaluation.answers, [
    {
      questionId: "route",
      type: "choice",
      value: "accept",
      uncertainty: {
        provenance: "provider",
        distribution: { accept: 0.8, review: 0.2 },
        confidence: 0.7,
      },
    },
    {
      questionId: "urgent",
      type: "predicate",
      probabilityTrue: 0.25,
      uncertainty: { provenance: "provider" },
    },
    {
      questionId: "severity",
      type: "ordinal",
      value: 1.2,
      levels: ["low", "medium", "high"],
      uncertainty: {
        provenance: "provider",
        distribution: { "0": 0.1, "1": 0.6, "2": 0.3 },
        confidence: 0.65,
      },
    },
  ]);
});

test("rejects oversized requests before transport and accepts the exact 1 MiB boundary", async () => {
  let calls = 0;
  const transport: JevTransport = async () => {
    calls += 1;
    return response(200, JSON.stringify({
      model: JEV_MODEL,
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  };
  const base: EvaluateRequest = {
    state: "",
    questionSetVersion: "v1",
    questions: [{ id: "q", type: "predicate", instructions: "Q?" }],
  };
  const baseWire = JSON.stringify({
    state: "",
    model: JEV_MODEL,
    questions: { q: { type: "noul", instructions: "Q?" } },
  });
  const exactState = "x".repeat(MAX_REQUEST_BYTES - Buffer.byteLength(baseWire));
  const service = serviceWith(transport);

  assert.equal((await service.evaluate({ ...base, state: exactState })).status, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(await service.evaluate({ ...base, state: `${exactState}x` }), {
    status: "unavailable",
    reason: "invalid_request",
  });
  assert.equal(calls, 1);
});

test("response cap is 1 MiB, accepts the boundary, and rejects without truncating", async () => {
  const json = JSON.stringify({
    model: JEV_MODEL,
    answers: { q: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const exact = `${json}${" ".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(json))}`;
  const base = {
    state: "x",
    questionSetVersion: "v1",
    questions: [{ id: "q", type: "predicate" as const, instructions: "Q?" }],
  };
  let body = exact;
  const service = serviceWith(async () => response(200, body));
  assert.equal((await service.evaluate(base)).status, "ok");
  body = `${exact} `;
  assert.deepEqual(await service.evaluate(base), {
    status: "unavailable",
    reason: "invalid_response",
  });
});

test("rejects an oversized Content-Length before consuming the response body", async () => {
  let iterated = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      iterated = true;
      yield Buffer.from("must not be read");
    },
  };
  const result = await serviceWith(async () =>
    response(200, body, {
      "content-length": String(MAX_RESPONSE_BYTES + 1),
    }),
  ).evaluate(request);
  assert.deepEqual(result, { status: "unavailable", reason: "invalid_response" });
  assert.equal(iterated, false);
});

test("retries 429/529 at most once and honors Retry-After inside the total budget", async () => {
  for (const status of [429, 529]) {
    let calls = 0;
    const sleeps: number[] = [];
    const service = serviceWith(
      async () => {
        calls += 1;
        return calls === 1
          ? response(status, "provider detail must stay private", { "retry-after": "0" })
          : response(200, JSON.stringify(validWireResponse()));
      },
      { sleep: async (ms: number) => sleeps.push(ms) },
    );
    assert.equal((await service.evaluate(request)).status, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [0]);
  }

  let calls = 0;
  const noTime = serviceWith(async () => {
    calls += 1;
    return response(429, "private", { "retry-after": "3" });
  });
  assert.deepEqual(await noTime.evaluate({ ...request, timeoutMs: 10 }), {
    status: "unavailable",
    reason: "rate_limit",
  });
  assert.equal(calls, 1);

  calls = 0;
  const twice = serviceWith(async () => {
    calls += 1;
    return response(529, "private", { "retry-after": "0" });
  }, { sleep: async () => {} });
  assert.deepEqual(await twice.evaluate(request), { status: "unavailable", reason: "overloaded" });
  assert.equal(calls, 2);
});

test("a 401 latches immediately from headers without reading the body", async (t) => {
  const cases: Array<[string, () => JevHttpResponse]> = [
    ["ordinary body", () => response(401, "test-key raw provider error")],
    ["oversized body", () => response(401, "", { "content-length": String(MAX_RESPONSE_BYTES + 1) })],
    ["erroring body", () => response(401, {
      async *[Symbol.asyncIterator]() {
        throw new Error("test-key raw provider error");
      },
    })],
  ];

  for (const [name, makeResponse] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const service = serviceWith(async () => {
        calls += 1;
        return makeResponse();
      });
      const first = await service.evaluate(request);
      const second = await service.evaluate(request);
      assert.deepEqual(first, { status: "unavailable", reason: "auth" });
      assert.deepEqual(second, { status: "unavailable", reason: "auth" });
      assert.equal(calls, 1);
      assert.equal(JSON.stringify([first, second]).includes("test-key"), false);
      assert.equal(JSON.stringify([first, second]).includes("raw provider"), false);
    });
  }
});

test("deadline covers transport/body and caller cancellation wins without retry or late use", async () => {
  let calls = 0;
  const hanging: JevTransport = async ({ signal }) => {
    calls += 1;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return response(200, JSON.stringify(validWireResponse()));
  };
  assert.deepEqual(await serviceWith(hanging).evaluate({ ...request, timeoutMs: 5 }), {
    status: "unavailable",
    reason: "timeout",
  });
  assert.equal(calls, 1);

  const stalledBody = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
      };
    },
  };
  assert.deepEqual(
    await serviceWith(async () => response(200, stalledBody)).evaluate({ ...request, timeoutMs: 5 }),
    { status: "unavailable", reason: "timeout" },
  );

  calls = 0;
  const controller = new AbortController();
  const pending = serviceWith(hanging).evaluate({ ...request, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(calls, 1);
});

test("maps ordinary HTTP and network failures to structured, sanitized results", async (t) => {
  const cases: Array<[string, JevTransport, object]> = [
    ["422", async () => response(422, "secret payload"), { status: "unavailable", reason: "invalid_request" }],
    ["500", async () => response(500, "secret payload"), { status: "unavailable", reason: "network" }],
    ["redirect is not followed", async () => response(302, "secret payload", { location: "https://elsewhere.invalid" }), { status: "unavailable", reason: "network" }],
    ["network", async () => { throw new Error("secret network body"); }, { status: "unavailable", reason: "network" }],
  ];
  for (const [name, transport, expected] of cases) {
    await t.test(name, async () => {
      const result = await serviceWith(transport).evaluate(request);
      assert.deepEqual(result, expected);
      assert.equal(JSON.stringify(result).includes("secret"), false);
    });
  }
});

test("accepts documented argmax and sums when rounding tolerance is unspecified", async () => {
  const rounded = validWireResponse();
  rounded.answers.route.probabilities = { accept: 0.6000001, review: 0.3999998 };
  rounded.answers.severity.score = 1.19;
  rounded.answers.severity.probabilities = { "0": 0.1, "1": 0.6, "2": 0.2999999 };

  const result = await serviceWith(async () => response(200, JSON.stringify(rounded))).evaluate(request);
  assert.equal(result.status, "ok");
});

test("rejects malformed, duplicate, incomplete, extra, mistyped, and invalid numeric batches", async (t) => {
  const duplicate = `{"model":"${JEV_MODEL}","answers":{"route":{"type":"choice","choice":"accept","probabilities":{"accept":0.8,"review":0.2},"confidence":0.7},"route":{"type":"choice","choice":"accept","probabilities":{"accept":0.8,"review":0.2},"confidence":0.7}},"usage":{"input_tokens":1,"output_tokens":1}}`;
  const cases: Array<[string, string | Uint8Array]> = [
    ["malformed", "{"],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["duplicate answer id", duplicate],
    ["missing answer", JSON.stringify({ ...validWireResponse(), answers: { route: validWireResponse().answers.route } })],
    ["extra answer", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, extra: { type: "noul", noul: 0.5 } } })],
    ["mistyped", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, urgent: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } } })],
    ["out of range", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, urgent: { type: "noul", noul: 1.1 } } })],
    ["bad distribution keys", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, route: { ...validWireResponse().answers.route, probabilities: { accept: 1 } } } })],
    ["out-of-range distribution value", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, route: { ...validWireResponse().answers.route, probabilities: { accept: 1.1, review: 0.2 } } } })],
    ["non-finite score", JSON.stringify({ ...validWireResponse(), answers: { ...validWireResponse().answers, severity: { ...validWireResponse().answers.severity, score: "NaN" } } })],
  ];

  for (const [name, body] of cases) {
    await t.test(name, async () => {
      assert.deepEqual(await serviceWith(async () => response(200, body)).evaluate(request), {
        status: "unavailable",
        reason: "invalid_response",
      });
    });
  }
});

test("body cancellation closes the iterator without waiting for cleanup", async () => {
  let returned = 0;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next: () => { started(); return new Promise<IteratorResult<Uint8Array>>(() => {}); },
        return: () => { returned += 1; return new Promise<IteratorResult<Uint8Array>>(() => {}); },
      };
    },
  };
  const controller = new AbortController();
  const pending = serviceWith(async () => response(200, body)).evaluate({ ...request, signal: controller.signal });
  await reading;
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(returned, 1);
});

test("oversized stream cleanup cannot hang beyond the request budget", async () => {
  let returned = 0;
  let signal: AbortSignal | undefined;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false as const, value: Buffer.alloc(MAX_RESPONSE_BYTES + 1) }),
        return: () => { returned += 1; return new Promise<IteratorResult<Uint8Array>>(() => {}); },
      };
    },
  };
  const result = await serviceWith(async (input) => {
    signal = input.signal;
    return response(200, body);
  }).evaluate(request);
  assert.deepEqual(result, { status: "unavailable", reason: "invalid_response" });
  assert.equal(returned, 1);
  assert.equal(signal?.aborted, true);
});

test("early auth and oversized header rejection abort unread transport bodies", async () => {
  for (const status of [401, 200]) {
    let signal: AbortSignal | undefined;
    const result = await serviceWith(async (input) => {
      signal = input.signal;
      return response(status, "", { "content-length": String(MAX_RESPONSE_BYTES + 1) });
    }).evaluate(request);
    assert.deepEqual(result, { status: "unavailable", reason: status === 401 ? "auth" : "invalid_response" });
    assert.equal(signal?.aborted, true);
  }
});

test("prototype-sensitive question IDs round-trip as own wire properties", async () => {
  const ids = ["__proto__", "constructor", "toString"];
  const result = await serviceWith(async (input) => {
    const wire = JSON.parse(input.body.toString());
    assert.deepEqual(Object.keys(wire.questions), ids);
    for (const id of ids) assert.equal(Object.hasOwn(wire.questions, id), true);
    return response(200, JSON.stringify({
      model: JEV_MODEL,
      answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.5 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  }).evaluate({
    ...request,
    questions: ids.map((id) => ({ id, type: "predicate", instructions: "Synthetic predicate" })),
  });
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.evaluation.answers.map((answer) => answer.questionId), ids);
});
