import { normalizeSystem1Config } from './config-v2.js';
export const SYSTEM1_CONFIG_RELATIVE_PATH = ".ai/system1.json";
export const SYSTEM1_CONFIG_VERSION = 2;
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
  const snapshot = normalizeSystem1Config(value);
  if (snapshot.status !== 'ready' && snapshot.status !== 'off') return { ok: false };
  return {
    ok: true,
    config: {
      ...snapshot.provider,
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
  if (config === undefined) return { status: "skipped", reason: "missing_config" };
  if (normalizeSystem1Config(config).status === 'migration_required') return { status: 'unavailable', reason: 'migration_required' };
  const validated = validateSystem1Config(config);
  if (!validated.ok) return { status: "unavailable", reason: "invalid_config" };
  if (validated.config.mode === 'off') return { status: 'skipped', reason: 'disabled' };
  const key = env[validated.config.apiKeyEnv];
  if (typeof key !== "string" || key.trim().length === 0) {
    return { status: "skipped", reason: "missing_key" };
  }
  return { status: "ready" };
}
