// tui.js — dependency-free prompt ownership and setup selection.
import { resolveDesiredFeatures, resolveFeatures } from "./features.js";
const CANCEL = /^(c|cancel|q|quit)$/i;
function enabledFeatures(desired) { return Object.entries(desired?.features ?? {}).filter(([, on]) => on).map(([name]) => name).sort(); }
function availability(manifest, platform) {
  return Object.keys(manifest.features ?? {}).sort().map((name) => {
    try { resolveDesiredFeatures(manifest, { preset: "default", features: [name], platform }); return { name, available: true, stability: manifest.features[name].stability ?? "stable" }; }
    catch (error) { return { name, available: false, stability: manifest.features[name].stability ?? "stable", reason: error.message }; }
  });
}
export function selectionSummary(manifest, preset, selected, platform = process.platform) {
  const effective = resolveFeatures(manifest, selected, { platform });
  const direct = [...selected].sort(); const deps = effective.filter((name) => !direct.includes(name));
  const label = preset === "full" ? "Full" : "Default";
  const describe = (values) => values.length ? values.map((name) => `${name} (${manifest.features[name].stability ?? "stable"})`).join(", ") : "none";
  return `Preset: ${label}\nSelected features: ${describe(direct)}\nDependency features: ${describe(deps)}\n`;
}
export async function askChoice({ output, readLine, prompt, validate }) {
  while (true) {
    // A real readline interface must own the prompt so its redraw/erase cycle
    // cannot clear text printed separately just before question(""). Test and
    // non-readline adapters retain the explicit output path.
    if (!readLine.ownsPrompt) output.write(prompt);
    const answer = await readLine(prompt);
    if (answer === null) return { cancelled: true, reason: "EOF" };
    if (answer === "__AGENT_FLEET_INTERRUPT__") return { cancelled: true, reason: "Ctrl+C" };
    const value = answer.trim();
    if (CANCEL.test(value)) return { cancelled: true, reason: "cancel" };
    const result = validate(value);
    if (result.ok) return { cancelled: false, value: result.value };
    output.write(`${result.error}\n`);
  }
}
export async function askFinalApproval({ output, readLine }) {
  return askChoice({ output, readLine, prompt: "Apply this setup plan? yes/y | no/n; Enter = no (cancel without applying) > ", validate: (value) => {
    if (/^y(?:es)?$/i.test(value)) return { ok: true, value: true };
    if (value === "" || /^n(?:o)?$/i.test(value)) return { ok: true, value: false };
    return { ok: false, error: "Invalid answer. Enter yes/y to apply or no/n to cancel." };
  } });
}
/** Collect editable desired state; the caller owns final exact-plan approval. */
export async function chooseSetup({ output, readLine, manifest, currentDesired = null, platform = process.platform }) {
  const currentPreset = currentDesired?.preset ?? "default";
  const currentFeatures = enabledFeatures(currentDesired);
  const available = availability(manifest, platform); const all = available.filter((x) => x.available).map((x) => x.name);
  const presetResult = await askChoice({ output, readLine,
    prompt: "Choose a preset:\n  [1] Default — recommended stable Fleet basics\n  [2] Full — every stable integration\n  [3] Full + all features — includes platform-compatible experimental features\n" +
      `Choose: 1 | 2 | 3 | cancel; Enter = ${currentPreset === "full" ? "Full" : "Default"} > `,
    validate(value) {
      if (value === "") return { ok: true, value: { preset: currentPreset, allFeatures: false } };
      if (value === "1" || value.toLowerCase() === "default") return { ok: true, value: { preset: "default", allFeatures: false } };
      if (value === "2" || value.toLowerCase() === "full") return { ok: true, value: { preset: "full", allFeatures: false } };
      if (value === "3" || /^full\s*\+\s*all/i.test(value)) return { ok: true, value: { preset: "full", allFeatures: true } };
      return { ok: false, error: "Invalid preset. Enter 1 (Default), 2 (Full), 3 (Full + all features), or cancel." };
    },
  });
  if (presetResult.cancelled) return presetResult;
  const preset = presetResult.value.preset;
  const featureDefault = presetResult.value.allFeatures ? all : currentFeatures;
  const listed = available.map((x) => `  - ${x.name} (${x.stability})${x.available ? "" : ` — unavailable: ${x.reason}`}`).join("\n");
  const featureResult = await askChoice({ output, readLine,
    prompt: `Available features:\n${listed}\nFeatures: <name>[,<name>...] | none | cancel; Enter = keep [${featureDefault.length ? featureDefault.join(",") : "none"}] > `,
    validate(value) {
      const selected = value === "" ? featureDefault : value.toLowerCase() === "none" ? [] : [...new Set(value.split(",").map((x) => x.trim()).filter(Boolean))].sort();
      const found = selected.find((name) => !available.some((entry) => entry.name === name));
      if (found) return { ok: false, error: `Unknown feature "${found}". Try again using a listed feature ID.` };
      const blocked = selected.find((name) => !available.find((entry) => entry.name === name)?.available);
      if (blocked) return { ok: false, error: `Feature "${blocked}" is unavailable on ${platform}.` };
      return { ok: true, value: selected };
    },
  });
  if (featureResult.cancelled) return featureResult;
  const features = featureResult.value;
  output.write(selectionSummary(manifest, preset, features, platform));
  return { cancelled: false, preset, features, allFeaturesSnapshot: presetResult.value.allFeatures, changed: preset !== currentPreset || features.join(",") !== currentFeatures.join(",") };
}
