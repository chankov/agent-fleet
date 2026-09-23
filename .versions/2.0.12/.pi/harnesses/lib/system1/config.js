export const SYSTEM1_CONFIG_RELATIVE_PATH = ".ai/system1.json";
export const SYSTEM1_CONFIG_VERSION = 1;
export const SYSTEM1_API_KEY_ENV = "TYPESAFE_API_KEY";
export const SYSTEM1_PROVIDER = "typesafe";
export const SYSTEM1_MODEL = "jev-1.13.0";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {{ok: true, config: import("./contracts.ts").System1Config} | {ok: false}}
 */
export function validateSystem1Config(value) {
  if (!isRecord(value)) return { ok: false };
  const keys = Object.keys(value);
  if (keys.length !== 5 || !["version", "mode", "provider", "model", "apiKeyEnv"].every((key) => keys.includes(key))) {
    return { ok: false };
  }
  if (value.version !== SYSTEM1_CONFIG_VERSION ||
      (value.mode !== "auto" && value.mode !== "off") ||
      value.provider !== SYSTEM1_PROVIDER ||
      value.model !== SYSTEM1_MODEL ||
      value.apiKeyEnv !== SYSTEM1_API_KEY_ENV) {
    return { ok: false };
  }
  return {
    ok: true,
    config: {
      version: value.version,
      mode: value.mode,
      provider: value.provider,
      model: value.model,
      apiKeyEnv: value.apiKeyEnv,
    },
  };
}

/**
 * Resolve readiness from caller-owned values. This function performs no I/O and
 * never returns the credential value.
 * @param {{selected: boolean, config: unknown, env?: Record<string, string | undefined>}} input
 * @returns {import("./contracts.ts").System1Availability}
 */
export function resolveSystem1Readiness({ selected, config, env = {} }) {
  if (!selected) return { status: "skipped", reason: "disabled" };
  if (isRecord(config) && config.mode === "off") return { status: "skipped", reason: "disabled" };
  if (config === undefined) return { status: "skipped", reason: "missing_config" };
  const validated = validateSystem1Config(config);
  if (!validated.ok) return { status: "unavailable", reason: "invalid_config" };
  const key = env[validated.config.apiKeyEnv];
  if (typeof key !== "string" || key.trim().length === 0) {
    return { status: "skipped", reason: "missing_key" };
  }
  return { status: "ready" };
}
