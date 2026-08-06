// desired.js — strict, human-owned desired-state configuration.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { featureNames, normalizeFeatureSet } from "./features.js";

export const DESIRED_SCHEMA_VERSION = 1;
export const DESIRED_FILE = ".ai/agent-fleet.json";

export function defaultDesired(manifest) {
  return {
    schemaVersion: DESIRED_SCHEMA_VERSION,
    preset: "default",
    features: Object.fromEntries(featureNames(manifest).map((name) => [name, false])),
  };
}

export function validateDesired(value, manifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("desired config must be an object");
  if (value.schemaVersion !== DESIRED_SCHEMA_VERSION) throw new Error(`desired schemaVersion must be ${DESIRED_SCHEMA_VERSION}`);
  if (!manifest.presets?.[value.preset]) throw new Error(`unknown preset "${value.preset}"`);
  if (!value.features || typeof value.features !== "object" || Array.isArray(value.features)) throw new Error("desired features must be an object");
  const known = new Set(featureNames(manifest));
  for (const [name, enabled] of Object.entries(value.features)) {
    if (!known.has(name)) throw new Error(`unknown feature "${name}"`);
    if (typeof enabled !== "boolean") throw new Error(`desired feature "${name}" must be boolean`);
  }
  return {
    schemaVersion: DESIRED_SCHEMA_VERSION,
    preset: value.preset,
    features: Object.fromEntries(featureNames(manifest).map((name) => [name, value.features[name] ?? false])),
  };
}

export function readDesired(workspace, manifest) {
  const path = join(workspace, DESIRED_FILE);
  if (!existsSync(path)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`invalid desired config ${DESIRED_FILE}: ${error.message}`); }
  return validateDesired(parsed, manifest);
}

function explicitFeatures(manifest, features) {
  if (features === undefined || features === null) return null;
  const enabled = new Set(normalizeFeatureSet(manifest, features));
  return Object.fromEntries(featureNames(manifest).map((name) => [name, enabled.has(name)]));
}

/**
 * Apply CLI/TUI precedence without writing the human-owned file. Phase 2 stages
 * `renderDesired()` only when `writeDesired` is true and its transaction commits.
 */
export function resolveDesiredState({
  workspace,
  manifest,
  preset = undefined,
  features = undefined,
  saveDesired = false,
  tuiDesired = null,
  dryRun = false,
} = {}) {
  const existing = readDesired(workspace, manifest);
  const base = existing ?? defaultDesired(manifest);
  const cliFeatures = explicitFeatures(manifest, features);
  const effective = tuiDesired
    ? validateDesired(tuiDesired, manifest)
    : {
      ...base,
      ...(preset === undefined ? {} : { preset }),
      ...(cliFeatures === null ? {} : { features: cliFeatures }),
    };
  const desired = validateDesired(effective, manifest);
  const hasOverride = preset !== undefined || cliFeatures !== null;
  return {
    desired,
    existing,
    path: join(workspace, DESIRED_FILE),
    // Missing desired state must be staged on a successful non-dry run. Existing
    // config only changes via explicit persistence or confirmed TUI editing.
    writeDesired: !dryRun && (!existing || Boolean(tuiDesired) || (hasOverride && saveDesired)),
  };
}

export function renderDesired(desired) {
  return JSON.stringify(desired, null, 2) + "\n";
}
