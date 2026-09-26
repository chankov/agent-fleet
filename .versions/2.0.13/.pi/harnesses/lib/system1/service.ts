import type {
  Capability,
  EvaluateRequest,
  JsonText,
  ProviderEvaluation,
  System1Answer,
  System1Availability,
  System1Provider,
  System1Question,
  System1Result,
  System1Service,
} from "./contracts.ts";
import { resolveSystem1Readiness, validateSystem1Config } from "./config.js";
import { createJevProvider, type JevTransport } from "./jev.ts";

export const DEFAULT_SYSTEM1_TIMEOUT_MS = 2_000;

export interface CreateSystem1ServiceOptions {
  provider?: System1Provider;
  availability?: System1Availability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isJsonText(value: unknown): value is JsonText {
  return (typeof value === "string" || Array.isArray(value) || isRecord(value)) &&
    isJsonValue(value, new WeakSet<object>());
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateQuestion(question: unknown): question is System1Question {
  if (!isRecord(question) || !validId(question.id) || !isJsonText(question.instructions)) {
    return false;
  }
  if (question.type === "choice") {
    if (!isRecord(question.options)) return false;
    const entries = Object.entries(question.options);
    return entries.length >= 2 && entries.length <= 255 && entries.every(
      ([key, value]) => validId(key) && (value === null || isJsonText(value)),
    );
  }
  if (question.type === "predicate") {
    if (question.criteria === undefined) return true;
    if (!isRecord(question.criteria)) return false;
    const criteria = question.criteria;
    const keys = Object.keys(criteria);
    return keys.every((key) => (key === "true" || key === "false") && isJsonText(criteria[key]));
  }
  if (question.type === "ordinal") {
    return Array.isArray(question.levels) &&
      question.levels.length >= 2 &&
      question.levels.length <= 10 &&
      question.levels.every((level) => typeof level === "string" && level.length > 0);
  }
  return false;
}

function validateRequest(request: EvaluateRequest): boolean {
  if (!isJsonText(request.state)) return false;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return false;
  if (typeof request.questionSetVersion !== "string" || request.questionSetVersion.length === 0) return false;
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) return false;
  if (!request.questions.every(validateQuestion)) return false;
  const ids = request.questions.map((question) => question.id);
  return new Set(ids).size === ids.length;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validDistribution(value: unknown, expectedKeys: readonly string[]): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => !actualKeys.includes(key))) {
    return false;
  }
  return actualKeys.map((key) => value[key]).every(isProbability);
}

function validUncertainty(answer: System1Answer): boolean {
  const uncertainty = answer.uncertainty;
  if (!isRecord(uncertainty)) return false;
  if (!["provider", "self_reported", "derived"].includes(String(uncertainty.provenance))) return false;
  return uncertainty.confidence === undefined || isProbability(uncertainty.confidence);
}

function validateAnswer(answer: unknown, question: System1Question): answer is System1Answer {
  if (!isRecord(answer) || answer.questionId !== question.id || answer.type !== question.type) return false;
  if (!validUncertainty(answer as unknown as System1Answer)) return false;

  if (question.type === "choice") {
    const distribution = (answer.uncertainty as Record<string, unknown>).distribution;
    return typeof answer.value === "string" &&
      Object.hasOwn(question.options, answer.value) &&
      (distribution === undefined || validDistribution(distribution, Object.keys(question.options)));
  }
  if (question.type === "predicate") {
    return isProbability(answer.probabilityTrue);
  }
  const distribution = (answer.uncertainty as Record<string, unknown>).distribution;
  return typeof answer.value === "number" &&
    Number.isFinite(answer.value) &&
    answer.value >= 0 &&
    answer.value <= question.levels.length - 1 &&
    Array.isArray(answer.levels) &&
    answer.levels.length === question.levels.length &&
    answer.levels.every((level, index) => level === question.levels[index]) &&
    (distribution === undefined || validDistribution(
      distribution,
      question.levels.map((_, index) => String(index)),
    ));
}

function hasRequiredUncertainty(answer: System1Answer, request: EvaluateRequest): boolean {
  const required = new Set(request.requiredCapabilities ?? []);
  if ((answer.type === "choice" || answer.type === "ordinal") &&
      required.has("distribution") && answer.uncertainty.distribution === undefined) {
    return false;
  }
  if (required.has("provider_confidence") && answer.uncertainty.confidence === undefined) return false;
  return true;
}

function validateEvaluation(
  evaluation: ProviderEvaluation,
  request: EvaluateRequest,
  provider: System1Provider,
): boolean {
  if (!isRecord(evaluation) || !Array.isArray(evaluation.answers) || !isRecord(evaluation.metadata)) return false;
  if (evaluation.answers.length !== request.questions.length) return false;
  const answerIds = evaluation.answers.map((answer) => answer?.questionId);
  if (new Set(answerIds).size !== answerIds.length) return false;
  if (!request.questions.every((question) => {
    const matches = evaluation.answers.filter((answer) => answer?.questionId === question.id);
    return matches.length === 1 &&
      validateAnswer(matches[0], question) &&
      hasRequiredUncertainty(matches[0], request);
  })) return false;

  const metadata = evaluation.metadata;
  if (metadata.provider !== provider.name || metadata.requestedModel !== provider.model) return false;
  if (!validId(metadata.returnedModel) || metadata.questionSetVersion !== request.questionSetVersion) return false;
  if (!Number.isFinite(metadata.latencyMs) || metadata.latencyMs < 0) return false;
  if (!Number.isInteger(metadata.attempts) || metadata.attempts < 1 || metadata.attempts > 2) return false;
  if (metadata.usage !== undefined) {
    if (!isRecord(metadata.usage)) return false;
    if (!Number.isInteger(metadata.usage.inputTokens) || metadata.usage.inputTokens < 0) return false;
    if (!Number.isInteger(metadata.usage.outputTokens) || metadata.usage.outputTokens < 0) return false;
  }
  return true;
}

function requiredCapabilities(request: EvaluateRequest): Capability[] {
  const required: Capability[] = [];
  for (const question of request.questions) {
    if (!required.includes(question.type)) required.push(question.type);
  }
  for (const capability of request.requiredCapabilities ?? []) {
    if (!required.includes(capability)) required.push(capability);
  }
  return required;
}

export interface CreateSystem1RuntimeOptions {
  selected: boolean;
  config: unknown;
  env?: Record<string, string | undefined>;
  transport?: JevTransport;
}

export interface System1Runtime {
  readiness: System1Availability;
  service: System1Service;
}

export function createSystem1Runtime(options: CreateSystem1RuntimeOptions): System1Runtime {
  const env = options.env ?? {};
  const readiness = resolveSystem1Readiness({ selected: options.selected, config: options.config, env });
  if (readiness.status !== "ready") {
    return { readiness, service: createSystem1Service({ availability: readiness }) };
  }
  const validated = validateSystem1Config(options.config);
  if (!validated.ok) {
    const unavailable = { status: "unavailable", reason: "invalid_config" } as const;
    return { readiness: unavailable, service: createSystem1Service({ availability: unavailable }) };
  }
  const apiKey = env[validated.config.apiKeyEnv];
  const provider = createJevProvider({ apiKey: typeof apiKey === "string" ? apiKey : "", transport: options.transport });
  return { readiness, service: createSystem1Service({ provider, availability: readiness }) };
}

export function createSystem1Service(options: CreateSystem1ServiceOptions): System1Service {
  const availability = options.availability ?? { status: "ready" as const };
  return {
    async evaluate(request): Promise<System1Result> {
      if (availability.status !== "ready") return availability;
      if (!validateRequest(request) || !options.provider) {
        return { status: "unavailable", reason: options.provider ? "invalid_request" : "invalid_config" };
      }
      if (request.signal?.aborted) return { status: "cancelled" };

      const missingCapabilities = requiredCapabilities(request).filter(
        (capability) => !options.provider!.capabilities.includes(capability),
      );
      if (missingCapabilities.length > 0) return { status: "unsupported", missingCapabilities };

      try {
        const result = await options.provider.evaluate({
          ...request,
          timeoutMs: Math.min(request.timeoutMs ?? DEFAULT_SYSTEM1_TIMEOUT_MS, DEFAULT_SYSTEM1_TIMEOUT_MS),
        });
        if (request.signal?.aborted) return { status: "cancelled" };
        if (result.status !== "ok") return result;
        if (!validateEvaluation(result.evaluation, request, options.provider)) {
          return { status: "unavailable", reason: "invalid_response" };
        }
        return result;
      } catch {
        return request.signal?.aborted
          ? { status: "cancelled" }
          : { status: "unavailable", reason: "network" };
      }
    },
  };
}
