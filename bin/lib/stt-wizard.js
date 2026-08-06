// Non-secret STT configuration. Values are env-var names only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDERS = {
  openai: { apiKeyEnv: "OPENAI_API_KEY" },
  groq: { apiKeyEnv: "GROQ_API_KEY" },
  azure: { apiKeyEnv: "AZURE_OPENAI_API_KEY", endpointEnv: "AZURE_OPENAI_ENDPOINT" },
};

export function validateSttConfig(value) {
  const spec = PROVIDERS[value?.provider];
  if (!spec) throw new Error(`unsupported STT provider "${value?.provider}"`);
  for (const key of ["apiKeyEnv", ...(spec.endpointEnv ? ["endpointEnv"] : [])]) {
    if (value[key] !== spec[key]) throw new Error(`${key} must be ${spec[key]} for ${value.provider}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|password/i.test(key) && !/Env$/.test(key)) throw new Error(`STT config must not store ${key}`);
    if (typeof item === "string" && /sk-[A-Za-z0-9]|AIza|ghp_/i.test(item)) throw new Error("STT config must not store secret values");
  }
  return { provider: value.provider, apiKeyEnv: spec.apiKeyEnv, ...(spec.endpointEnv ? { endpointEnv: spec.endpointEnv } : {}) };
}

export function renderSttConfig(value) { return JSON.stringify(validateSttConfig(value), null, 2) + "\n"; }

/** Append empty placeholders only for variables not already declared. */
export function appendEnvPlaceholders(workspace, config) {
  const path = join(workspace, ".env");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const names = [config.apiKeyEnv, config.endpointEnv].filter(Boolean);
  const missing = names.filter((name) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(before));
  return { path, text: missing.length ? `${before}${before && !before.endsWith("\n") ? "\n" : ""}${missing.map((name) => `${name}=`).join("\n")}\n` : before, missing };
}
