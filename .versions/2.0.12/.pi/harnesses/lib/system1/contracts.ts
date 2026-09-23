export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonText = string | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type System1State = JsonText;

export interface System1Config {
  version: 1;
  mode: "auto" | "off";
  provider: "typesafe";
  model: "jev-1.13.0";
  apiKeyEnv: "TYPESAFE_API_KEY";
}

export type Capability =
  | "choice"
  | "predicate"
  | "ordinal"
  | "distribution"
  | "probability_true"
  | "provider_confidence";

interface QuestionBase {
  id: string;
  instructions: JsonText;
}

export interface ChoiceQuestion extends QuestionBase {
  type: "choice";
  options: Readonly<Record<string, JsonText | null>>;
}

export interface PredicateQuestion extends QuestionBase {
  type: "predicate";
  criteria?: {
    readonly true?: JsonText;
    readonly false?: JsonText;
  };
}

export interface OrdinalQuestion extends QuestionBase {
  type: "ordinal";
  levels: readonly string[];
}

export type System1Question = ChoiceQuestion | PredicateQuestion | OrdinalQuestion;

export interface EvaluateRequest {
  state: System1State;
  questions: readonly System1Question[];
  questionSetVersion: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  requiredCapabilities?: readonly Capability[];
}

export interface ProviderEvaluateRequest extends EvaluateRequest {
  timeoutMs: number;
}

export interface ProviderUncertainty {
  provenance: "provider" | "self_reported" | "derived";
  distribution?: Readonly<Record<string, number>>;
  confidence?: number;
}

export interface ChoiceAnswer {
  questionId: string;
  type: "choice";
  value: string;
  uncertainty: ProviderUncertainty;
}

export interface PredicateAnswer {
  questionId: string;
  type: "predicate";
  probabilityTrue: number;
  uncertainty: ProviderUncertainty;
}

export interface OrdinalAnswer {
  questionId: string;
  type: "ordinal";
  value: number;
  levels: readonly string[];
  uncertainty: ProviderUncertainty;
}

export type System1Answer = ChoiceAnswer | PredicateAnswer | OrdinalAnswer;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface EvaluationMetadata {
  provider: string;
  requestedModel: string;
  returnedModel: string;
  questionSetVersion: string;
  latencyMs: number;
  attempts: number;
  usage?: Usage;
}

export interface ProviderEvaluation {
  answers: System1Answer[];
  metadata: EvaluationMetadata;
}

export type SkippedReason = "disabled" | "missing_config" | "missing_key";
export type UnavailableReason =
  | "timeout"
  | "network"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_response"
  | "invalid_config"
  | "invalid_request";

export type System1Result =
  | { status: "ok"; evaluation: ProviderEvaluation }
  | { status: "skipped"; reason: SkippedReason }
  | { status: "unavailable"; reason: UnavailableReason }
  | { status: "unsupported"; missingCapabilities: Capability[] }
  | { status: "cancelled" };

export type ProviderResult =
  | { status: "ok"; evaluation: ProviderEvaluation }
  | { status: "unavailable"; reason: UnavailableReason }
  | { status: "cancelled" };

export interface System1Provider {
  readonly name: string;
  readonly model: string;
  capabilities: Capability[];
  evaluate(request: ProviderEvaluateRequest): Promise<ProviderResult>;
}

export type System1Availability =
  | { status: "ready" }
  | { status: "skipped"; reason: SkippedReason }
  | { status: "unavailable"; reason: "invalid_config" };

export interface System1Service {
  evaluate(request: EvaluateRequest): Promise<System1Result>;
}
