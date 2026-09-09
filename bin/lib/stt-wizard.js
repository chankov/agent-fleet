// Human-owned, non-secret STT configuration. Installer prompts for provider/env names, never values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STT_PROVIDERS = {
  openai: { apiKeyEnv: "OPENAI_API_KEY" },
  groq: { apiKeyEnv: "GROQ_API_KEY" },
  azure: { apiKeyEnv: "AZURE_OPENAI_API_KEY", endpointEnv: "AZURE_OPENAI_ENDPOINT" },
};
export function validateSttConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("STT config must be an object");
  if (!STT_PROVIDERS[value.provider]) throw new Error(`unsupported STT provider "${value.provider}"`);
  for (const key of ["apiKeyEnv", ...(value.provider === "azure" ? ["endpointEnv"] : [])]) {
    if (typeof value[key] !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value[key])) throw new Error(`${key} must name an environment variable`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|password/i.test(key) && !/Env$/.test(key)) throw new Error(`STT config must not store ${key}`);
    if (typeof item === "string" && /(?:sk-[A-Za-z0-9]|AIza|ghp_)/i.test(item)) throw new Error("STT config must not store secret values");
  }
  return structuredClone(value); // unknown human-owned fields are valid and preserved.
}
export function renderSttConfig(value) { return JSON.stringify(validateSttConfig(value), null, 2) + "\n"; }
export function readSttConfig(workspace) {
  const path = join(workspace, ".ai", "stt.json");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  try { return { path, text, config: validateSttConfig(JSON.parse(text)) }; }
  catch (error) { throw new Error(`invalid .ai/stt.json: ${error.message}; repair it manually before setup`); }
}
/** Append empty placeholders only for variables not already declared. */
export function appendEnvPlaceholders(workspace, config) {
  const path = join(workspace, ".env");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const names = [config.apiKeyEnv, config.endpointEnv].filter(Boolean);
  const missing = names.filter((name) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(before));
  return { path, text: missing.length ? `${before}${before && !before.endsWith("\n") ? "\n" : ""}${missing.map((name) => `${name}=`).join("\n")}\n` : before, missing };
}
export function planStt(workspace, provider, { replacementApproved = false } = {}) {
  const existing = readSttConfig(workspace);
  if (existing && (!provider || provider === existing.config.provider)) {
    return { path: existing.path, write: false, preserved: true, provider: existing.config.provider, env: appendEnvPlaceholders(workspace, existing.config) };
  }
  if (!provider || !STT_PROVIDERS[provider]) throw new Error(`first-time voice setup requires an explicit STT provider: ${Object.keys(STT_PROVIDERS).join(", ")}`);
  if (existing && !replacementApproved) throw new Error(`replacing STT provider ${existing.config.provider} with ${provider} requires explicit approval`);
  const config = validateSttConfig({ ...(existing?.config ?? {}), provider, ...STT_PROVIDERS[provider] });
  return { path: join(workspace, ".ai", "stt.json"), text: renderSttConfig(config), write: true, preserved: false, replacing: existing?.config.provider ?? null, provider, env: appendEnvPlaceholders(workspace, config) };
}
