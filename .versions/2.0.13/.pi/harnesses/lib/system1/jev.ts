import https from "node:https";

import type {
  ChoiceQuestion,
  OrdinalQuestion,
  PredicateQuestion,
  ProviderEvaluation,
  ProviderResult,
  System1Answer,
  System1Provider,
  System1Question,
  UnavailableReason,
} from "./contracts.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 100;

export interface JevHttpRequest {
  url: typeof JEV_ENDPOINT;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  signal: AbortSignal;
}

export interface JevHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string | Uint8Array | AsyncIterable<Uint8Array>;
}

export type JevTransport = (request: JevHttpRequest) => Promise<JevHttpResponse>;

export interface CreateJevProviderOptions {
  apiKey: string;
  transport?: JevTransport;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

class Aborted extends Error {}
class Oversized extends Error {}
class InvalidResponse extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Aborted());
    }, { once: true });
  });
}

export const defaultJevTransport: JevTransport = (input) => new Promise((resolve, reject) => {
  const url = new URL(input.url);
  const request = https.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: input.method,
    headers: {
      ...input.headers,
      "content-length": String(input.body.byteLength),
    },
    signal: input.signal,
  }, (response) => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    resolve({
      status: response.statusCode ?? 0,
      headers,
      body: response,
    });
  });
  request.on("error", reject);
  request.end(input.body);
});

function wireQuestion(question: System1Question): Record<string, unknown> {
  if (question.type === "choice") {
    return { type: "choice", instructions: question.instructions, criteria: question.options };
  }
  if (question.type === "predicate") {
    return {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
    };
  }
  return { type: "score", instructions: question.instructions, criteria: question.levels };
}

function makeBody(state: unknown, questions: readonly System1Question[]): Buffer {
  const wireQuestions = Object.fromEntries(
    questions.map((question) => [question.id, wireQuestion(question)]),
  );
  return Buffer.from(JSON.stringify({ state, model: JEV_MODEL, questions: wireQuestions }), "utf8");
}

function responseHeader(headers: JevHttpResponse["headers"], name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

async function readBoundedBody(response: JevHttpResponse, signal: AbortSignal): Promise<Buffer> {
  const lengthHeader = responseHeader(response.headers, "content-length");
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) throw new InvalidResponse();
    if (length > MAX_RESPONSE_BYTES) throw new Oversized();
  }

  if (typeof response.body === "string" || response.body instanceof Uint8Array) {
    const buffer = Buffer.from(response.body);
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Oversized();
    return buffer;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Oversized();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    // Cleanup must not extend the deadline: an injected iterator may never settle.
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); }
    catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

// JSON.parse silently accepts duplicate object keys. Provider batches cannot, so parse strictly.
function parseJsonStrict(source: string): unknown {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(source[index] ?? "")) index += 1;
  };
  const value = (): unknown => {
    whitespace();
    const character = source[index];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return string();
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(token, index)) {
        index += token.length;
        return result;
      }
    }
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new InvalidResponse();
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new InvalidResponse();
    return number;
  };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          throw new InvalidResponse();
        }
      }
      if ((source.charCodeAt(index) || 0) < 0x20) throw new InvalidResponse();
      index += 1;
    }
    throw new InvalidResponse();
  };
  const object = (): Record<string, unknown> => {
    index += 1;
    whitespace();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return result;
    }
    while (true) {
      whitespace();
      if (source[index] !== '"') throw new InvalidResponse();
      const key = string();
      if (keys.has(key)) throw new InvalidResponse();
      keys.add(key);
      whitespace();
      if (source[index] !== ":") throw new InvalidResponse();
      index += 1;
      result[key] = value();
      whitespace();
      if (source[index] === "}") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") throw new InvalidResponse();
      index += 1;
    }
  };
  const array = (): unknown[] => {
    index += 1;
    whitespace();
    const result: unknown[] = [];
    if (source[index] === "]") {
      index += 1;
      return result;
    }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") throw new InvalidResponse();
      index += 1;
    }
  };
  const result = value();
  whitespace();
  if (index !== source.length) throw new InvalidResponse();
  return result;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, keys: readonly string[]): Record<string, number> {
  if (!isRecord(value)) throw new InvalidResponse();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw new InvalidResponse();
  const entries: Array<[string, number]> = [];
  for (const key of keys) {
    if (!probability(value[key])) throw new InvalidResponse();
    entries.push([key, value[key]]);
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function choiceAnswer(question: ChoiceQuestion, wire: Record<string, unknown>): System1Answer {
  const keys = Object.keys(question.options);
  const probabilities = distribution(wire.probabilities, keys);
  if (wire.type !== "choice" || typeof wire.choice !== "string" || !keys.includes(wire.choice)) {
    throw new InvalidResponse();
  }
  if (!probability(wire.confidence)) throw new InvalidResponse();
  return {
    questionId: question.id,
    type: "choice",
    value: wire.choice,
    uncertainty: { provenance: "provider", distribution: probabilities, confidence: wire.confidence },
  };
}

function predicateAnswer(question: PredicateQuestion, wire: Record<string, unknown>): System1Answer {
  if (wire.type !== "noul" || !probability(wire.noul)) throw new InvalidResponse();
  return {
    questionId: question.id,
    type: "predicate",
    probabilityTrue: wire.noul,
    uncertainty: { provenance: "provider" },
  };
}

function ordinalAnswer(question: OrdinalQuestion, wire: Record<string, unknown>): System1Answer {
  const keys = question.levels.map((_, index) => String(index));
  const probabilities = distribution(wire.probabilities, keys);
  if (wire.type !== "score" || typeof wire.score !== "number" || !Number.isFinite(wire.score)) {
    throw new InvalidResponse();
  }
  if (wire.score < 0 || wire.score > question.levels.length - 1 || !probability(wire.confidence)) {
    throw new InvalidResponse();
  }
  if (!isRecord(wire.legend)) throw new InvalidResponse();
  const legend = wire.legend;
  if (Object.keys(legend).length !== keys.length ||
      keys.some((key, index) => legend[key] !== question.levels[index])) {
    throw new InvalidResponse();
  }
  return {
    questionId: question.id,
    type: "ordinal",
    value: wire.score,
    levels: [...question.levels],
    uncertainty: { provenance: "provider", distribution: probabilities, confidence: wire.confidence },
  };
}

function parseEvaluation(
  body: Buffer,
  questions: readonly System1Question[],
  questionSetVersion: string,
  latencyMs: number,
  attempts: number,
): ProviderEvaluation {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidResponse();
  }
  const wire = parseJsonStrict(source);
  if (!isRecord(wire) || wire.model !== JEV_MODEL || !isRecord(wire.answers) || !isRecord(wire.usage)) {
    throw new InvalidResponse();
  }
  const wireAnswers = wire.answers;
  const expectedIds = questions.map((question) => question.id);
  const actualIds = Object.keys(wireAnswers);
  if (actualIds.length !== expectedIds.length || expectedIds.some((id) => !actualIds.includes(id))) {
    throw new InvalidResponse();
  }
  const inputTokens = wire.usage.input_tokens;
  const outputTokens = wire.usage.output_tokens;
  if (!Number.isInteger(inputTokens) || (inputTokens as number) < 0 ||
      !Number.isInteger(outputTokens) || (outputTokens as number) < 0) {
    throw new InvalidResponse();
  }
  const answers = questions.map((question) => {
    const answer = wireAnswers[question.id];
    if (!isRecord(answer)) throw new InvalidResponse();
    if (question.type === "choice") return choiceAnswer(question, answer);
    if (question.type === "predicate") return predicateAnswer(question, answer);
    return ordinalAnswer(question, answer);
  });
  return {
    answers,
    metadata: {
      provider: "typesafe",
      requestedModel: JEV_MODEL,
      returnedModel: wire.model,
      questionSetVersion,
      latencyMs,
      attempts,
      usage: { inputTokens: inputTokens as number, outputTokens: outputTokens as number },
    },
  };
}

function retryDelay(header: string | undefined, now: number): number {
  if (header === undefined) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return DEFAULT_RETRY_DELAY_MS;
  return Math.max(0, date - now);
}

function statusReason(status: number): UnavailableReason {
  if (status === 401) return "auth";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  return "network";
}

export function createJevProvider(options: CreateJevProviderOptions): System1Provider {
  const transport = options.transport ?? defaultJevTransport;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let authFailed = false;

  return {
    name: "typesafe",
    model: JEV_MODEL,
    capabilities: [
      "choice",
      "predicate",
      "ordinal",
      "distribution",
      "probability_true",
    ],
    async evaluate(request): Promise<ProviderResult> {
      if (authFailed) return { status: "unavailable", reason: "auth" };
      if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
        return { status: "unavailable", reason: "invalid_config" };
      }
      const body = makeBody(request.state, request.questions);
      if (body.byteLength > MAX_REQUEST_BYTES) {
        return { status: "unavailable", reason: "invalid_request" };
      }
      if (request.signal?.aborted) return { status: "cancelled" };

      const started = now();
      const deadline = started + request.timeoutMs;
      const controller = new AbortController();
      let timedOut = false;
      let callerCancelled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);
      const cancel = () => {
        callerCancelled = true;
        controller.abort();
      };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();

      let attempts = 0;
      try {
        while (attempts < 2) {
          attempts += 1;
          const httpResponse = await raceAbort(transport({
            url: JEV_ENDPOINT,
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
            signal: controller.signal,
          }), controller.signal);
          if (httpResponse.status === 401) {
            authFailed = true;
            return { status: "unavailable", reason: "auth" };
          }
          const responseBody = await readBoundedBody(httpResponse, controller.signal);
          if (httpResponse.status === 200) {
            const evaluation = parseEvaluation(
              responseBody,
              request.questions,
              request.questionSetVersion,
              Math.max(0, now() - started),
              attempts,
            );
            if (controller.signal.aborted) throw new Aborted();
            return { status: "ok", evaluation };
          }
          if ((httpResponse.status === 429 || httpResponse.status === 529) && attempts === 1) {
            const delay = retryDelay(responseHeader(httpResponse.headers, "retry-after"), now());
            if (now() + delay >= deadline) return { status: "unavailable", reason: statusReason(httpResponse.status) };
            await raceAbort(sleep(delay, controller.signal), controller.signal);
            continue;
          }
          return { status: "unavailable", reason: statusReason(httpResponse.status) };
        }
        return { status: "unavailable", reason: "network" };
      } catch (error) {
        if (callerCancelled || request.signal?.aborted) return { status: "cancelled" };
        if (timedOut || now() >= deadline) return { status: "unavailable", reason: "timeout" };
        if (error instanceof Oversized || error instanceof InvalidResponse) {
          return { status: "unavailable", reason: "invalid_response" };
        }
        return { status: "unavailable", reason: "network" };
      } finally {
        // Destroy any unread native response, including early 401/header rejection.
        // Authentication is latched before this cleanup and before reading a body.
        controller.abort();
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
