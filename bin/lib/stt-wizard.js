// Human-owned, non-secret STT configuration. Installer prompts for provider/env names, never values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RUNTIME_PROVIDER_TYPES = new Set(["openai", "openai-compatible", "azure", "azure-openai"]);
const LEGACY_PROVIDER_FIELDS = new Set([
  "apiKeyEnv", "endpointEnv", "endpoint", "baseUrl", "model", "deployment", "apiVersion", "format", "locales",
]);

// These are installer selections, not a list of runtime provider.type values.
export const STT_PROVIDERS = {
  openai: { runtimeType: "openai" },
  groq: { preparedConfigRequired: true },
  azure: { runtimeType: "azure", preparedConfigRequired: true },
  "azure-openai": { runtimeType: "azure-openai", preparedConfigRequired: true },
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertString(value, path) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}
function assertOptionalString(object, key, path = key) {
  if (object[key] !== undefined) assertString(object[key], path);
}
function assertEnvName(value, path) {
  if (typeof value !== "string" || !ENV_NAME.test(value)) throw new Error(`${path} must name an environment variable`);
}
function isSecretField(key) {
  if (/Env$/.test(key)) return false;
  return /api.?key|access.?token|auth.?token|secret|password|credential|private.?key/i.test(key);
}
function containsSecretValue(value) {
  return typeof value === "string" && /(?:sk-[A-Za-z0-9]|AIza[A-Za-z0-9_-]|gh[pousr]_|Bearer\s+)/i.test(value);
}
function validateSafeTree(value, path = "STT config") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const field = `${path}.${key}`;
    if (isSecretField(key)) throw new Error("STT config must not store secret fields");
    if (/Env$/.test(key)) assertEnvName(item, field);
    if (containsSecretValue(item)) throw new Error("STT config must not store secret values");
    validateSafeTree(item, field);
  }
}
function validateCapture(capture) {
  if (!isObject(capture)) throw new Error("capture must be an object");
  for (const key of ["ffmpegPath", "inputFormat", "input"]) assertOptionalString(capture, key, `capture.${key}`);
  for (const key of ["sampleRate", "channels", "maxSeconds", "minBytes"]) {
    if (capture[key] !== undefined && (typeof capture[key] !== "number" || !Number.isFinite(capture[key]) || capture[key] <= 0)) {
      throw new Error(`capture.${key} must be a positive number`);
    }
  }
}
function validateNestedProvider(provider) {
  if (!isObject(provider)) throw new Error("provider must be an object or supported legacy provider");
  if (typeof provider.type !== "string" || !RUNTIME_PROVIDER_TYPES.has(provider.type)) {
    throw new Error("unsupported provider.type");
  }
  for (const key of ["apiKeyEnv", "endpointEnv"]) {
    if (provider[key] !== undefined) assertEnvName(provider[key], `provider.${key}`);
  }
  for (const key of ["endpoint", "baseUrl", "model", "deployment", "apiVersion"]) {
    assertOptionalString(provider, key, `provider.${key}`);
  }
  if (provider.type === "azure-openai" && (typeof provider.deployment !== "string" || !provider.deployment.trim())) {
    throw new Error("provider.deployment is required for provider.type azure-openai");
  }
  if (provider.format !== undefined && !["simple", "detailed"].includes(provider.format)) {
    throw new Error("provider.format must be simple or detailed");
  }
  if (provider.locales !== undefined && (!Array.isArray(provider.locales) || provider.locales.some((item) => typeof item !== "string"))) {
    throw new Error("provider.locales must be an array of strings");
  }
}
function validateLegacyProvider(value) {
  if (!Object.hasOwn(STT_PROVIDERS, value.provider) || value.provider === "azure-openai") {
    throw new Error("unsupported legacy STT provider");
  }
  assertEnvName(value.apiKeyEnv, "apiKeyEnv");
  if (value.provider === "azure") assertEnvName(value.endpointEnv, "endpointEnv");
}

export function validateSttConfig(value) {
  if (!isObject(value)) throw new Error("STT config must be an object");
  if (typeof value.provider === "string") validateLegacyProvider(value);
  else validateNestedProvider(value.provider);
  if (value.keybind !== undefined) assertString(value.keybind, "keybind");
  if (value.language !== undefined) assertString(value.language, "language");
  if (value.capture !== undefined) validateCapture(value.capture);
  validateSafeTree(value);
  return structuredClone(value); // Validation and metadata extraction never mutate human-owned config.
}

export function renderSttConfig(value) {
  return JSON.stringify(validateSttConfig(value), null, 2) + "\n";
}

function providerMetadata(config) {
  if (typeof config.provider === "string") {
    return { format: "legacy", providerType: null, providerAlias: config.provider, provider: config.provider, warning: "legacy STT config preserved without automatic migration; runtime compatibility is not guaranteed" };
  }
  const providerType = config.provider.type;
  const providerAlias = providerType === "openai" || providerType === "azure" || providerType === "azure-openai" ? providerType : null;
  return { format: "runtime", providerType, providerAlias, provider: providerType, warning: null };
}

export function readSttConfig(workspace) {
  const path = join(workspace, ".ai", "stt.json");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("invalid .ai/stt.json: invalid JSON; repair it manually before setup"); }
  try {
    const config = validateSttConfig(parsed);
    return { path, text, config, ...providerMetadata(config) };
  } catch (error) {
    throw new Error(`invalid .ai/stt.json: ${error.message}; repair it manually before setup`);
  }
}

function requiredEnvNames(config) {
  if (typeof config.provider === "string") return [config.apiKeyEnv, config.endpointEnv].filter(Boolean);
  const provider = config.provider;
  const names = [];
  if (provider.apiKeyEnv) names.push(provider.apiKeyEnv);
  else names.push(provider.type === "azure" ? "AZURE_SPEECH_KEY" : provider.type === "azure-openai" ? "AZURE_OPENAI_API_KEY" : "OPENAI_API_KEY");
  if ((provider.type === "azure" || provider.type === "azure-openai") && !provider.endpoint) {
    names.push(provider.endpointEnv || (provider.type === "azure" ? "AZURE_SPEECH_ENDPOINT" : "AZURE_OPENAI_ENDPOINT"));
  }
  return [...new Set(names)];
}

/** Append empty placeholders only for variables not already declared. */
export function appendEnvPlaceholders(workspace, config) {
  const path = join(workspace, ".env");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const names = requiredEnvNames(config);
  const missing = names.filter((name) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(before));
  const suffix = missing.length ? `${before && !before.endsWith("\n") ? "\n" : ""}${missing.map((name) => `${name}=`).join("\n")}\n` : "";
  return { path, text: before + suffix, missing };
}

function generatedConfig(existing, provider) {
  const retained = structuredClone(existing?.config ?? {});
  if (typeof retained.provider === "string") {
    for (const field of LEGACY_PROVIDER_FIELDS) delete retained[field];
  }
  retained.provider = { type: STT_PROVIDERS[provider].runtimeType };
  return validateSttConfig(retained);
}

export function planStt(workspace, provider, { replacementApproved = false } = {}) {
  const existing = readSttConfig(workspace);
  if (existing && (!provider || provider === existing.providerAlias)) {
    return { path: existing.path, write: false, preserved: true, provider: existing.provider, format: existing.format, warning: existing.warning, env: appendEnvPlaceholders(workspace, existing.config) };
  }
  if (!provider || !Object.hasOwn(STT_PROVIDERS, provider)) {
    throw new Error(`first-time voice setup requires an explicit STT provider: ${Object.keys(STT_PROVIDERS).join(", ")}`);
  }
  if (existing && !replacementApproved) throw new Error(`replacing STT provider ${existing.provider} with ${provider} requires explicit approval`);
  if (STT_PROVIDERS[provider].preparedConfigRequired) {
    throw new Error(`${provider} setup requires a prepared nested .ai/stt.json with provider-specific settings; no values were guessed`);
  }
  const config = generatedConfig(existing, provider);
  return {
    path: join(workspace, ".ai", "stt.json"),
    text: renderSttConfig(config),
    write: true,
    preserved: false,
    replacing: existing?.provider ?? null,
    provider,
    env: appendEnvPlaceholders(workspace, config),
  };
}
