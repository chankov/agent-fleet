// tui.js — dependency-free, readline-driven setup selection.

const CANCEL = /^(c|cancel|q|quit)$/i;

function enabledFeatures(desired) {
  return Object.entries(desired?.features ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort();
}

function featureList(manifest) {
  return Object.keys(manifest.features ?? {}).sort()
    .map((name) => `  - ${name} (${manifest.features[name].stability ?? "stable"})`)
    .join("\n");
}

/**
 * Collect an editable desired-state selection. Application confirmation belongs
 * to the caller after it has rendered the complete reconciliation plan.
 */
export async function chooseSetup({ output, readLine, manifest, currentDesired = null }) {
  const currentPreset = currentDesired?.preset ?? "default";
  const currentFeatures = enabledFeatures(currentDesired);
  const ask = async (question) => {
    output.write(question);
    return readLine();
  };

  let preset;
  while (!preset) {
    const answer = await ask(
      "Choose a preset:\n" +
      "  [1] Default — recommended stable Fleet basics\n" +
      "  [2] Full — every stable integration (experimental features excluded)\n" +
      `Preset [${currentPreset}]: `,
    );
    if (answer === null || CANCEL.test(answer.trim())) return { cancelled: true };
    const value = answer.trim().toLowerCase();
    preset = value === "" ? currentPreset : value === "1" || value === "default" ? "default" : value === "2" || value === "full" ? "full" : null;
    if (!preset) output.write('Invalid preset. Enter 1 (Default), 2 (Full), or cancel.\n');
  }

  const known = new Set(Object.keys(manifest.features ?? {}));
  let features;
  while (!features) {
    const current = currentFeatures.length ? currentFeatures.join(",") : "none";
    const answer = await ask(
      `Optional features (comma-separated; blank keeps ${current}; "none" disables all):\n` +
      `${featureList(manifest)}\n` +
      "Experimental features are opt-in only and are never included by Full.\n" +
      "Features: ",
    );
    if (answer === null || CANCEL.test(answer.trim())) return { cancelled: true };
    const value = answer.trim();
    const selected = value === "" ? currentFeatures : value === "none" ? [] : [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))].sort();
    const unknown = selected.find((name) => !known.has(name));
    if (unknown) {
      output.write(`Unknown feature "${unknown}". Try again using one of the listed feature IDs.\n`);
      continue;
    }
    features = selected;
  }

  return {
    cancelled: false,
    preset,
    features,
    changed: preset !== currentPreset || features.join(",") !== currentFeatures.join(","),
  };
}
