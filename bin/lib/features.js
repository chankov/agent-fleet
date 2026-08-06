// features.js — resolve schema-v2 presets and supported capabilities.

import { resolveSelection } from "./manifest.js";

export function featureNames(manifest) {
  return Object.keys(manifest.features ?? {}).sort();
}

export function normalizeFeatureSet(manifest, features) {
  const known = new Set(featureNames(manifest));
  const values = typeof features === "string"
    ? (features === "none" ? [] : features.split(",").filter(Boolean))
    : (features ?? []);
  for (const feature of values) {
    if (!known.has(feature)) throw new Error(`unknown feature "${feature}"`);
  }
  return [...new Set(values)].sort();
}

/** Resolve selected features with their feature dependencies (Telegram → Hermes). */
export function resolveFeatures(manifest, selected = [], { platform = process.platform } = {}) {
  const features = manifest.features ?? {};
  const enabled = new Set(normalizeFeatureSet(manifest, selected));
  const visit = (name) => {
    const feature = features[name];
    if (!feature) throw new Error(`unknown feature "${name}"`);
    if (feature.platform && feature.platform !== "any" && feature.platform !== platform) {
      throw new Error(`feature "${name}" is unavailable on ${platform}`);
    }
    for (const dependency of feature.requiresFeatures ?? []) {
      enabled.add(dependency);
      visit(dependency);
    }
  };
  for (const name of [...enabled]) visit(name);
  return [...enabled].sort();
}

/** Resolve desired roots and their normal requires/companion closure. */
export function resolveDesiredFeatures(manifest, {
  preset = "default",
  features = undefined,
  agent = "pi",
  platform = process.platform,
} = {}) {
  const declaration = manifest.presets?.[preset];
  if (!declaration) throw new Error(`unknown preset "${preset}"`);
  const enabledFeatures = resolveFeatures(
    manifest,
    features ?? (preset === "full"
      ? featureNames(manifest).filter((name) => manifest.features[name].stability === "stable")
      : []),
    { platform },
  );
  const roots = new Set();

  if (declaration.rule === "stable") {
    for (const item of manifest.items ?? []) {
      if (item.kind !== "companion" && item.stability === "stable" && item.agents?.[agent]
        && (item.platform === "any" || item.platform === platform)) roots.add(item.id);
    }
  }
  for (const item of declaration.items ?? []) roots.add(item);
  for (const name of enabledFeatures) {
    for (const item of manifest.features[name].items ?? []) roots.add(item);
  }

  const byId = new Map((manifest.items ?? []).map((item) => [item.id, item]));
  for (const id of roots) {
    const item = byId.get(id);
    if (item && item.platform !== "any" && item.platform !== platform) {
      throw new Error(`desired item "${id}" is unavailable on ${platform}`);
    }
  }
  const resolution = resolveSelection(manifest, agent, { items: [...roots] });
  if (resolution.unknown.length) throw new Error(`unavailable desired item(s): ${resolution.unknown.join(", ")}`);
  return { preset, features: enabledFeatures, roots: [...roots].sort(), selected: resolution.selected };
}
