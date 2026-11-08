// inspect.js — one read-only JSON report composed from the existing evaluators.
//
// `agent-fleet inspect` exists so an in-session screen (the harness's
// /af-config) can show installer evaluation — item states, drift findings,
// feature availability, provenance status — without re-deriving any rule.
// Every section is a composition of exports that already exist (verify,
// doctor, desired/features, project-provenance); nothing here decides anything
// new, and nothing here writes.

import { readProjectProvenance } from "./project-provenance.js";
import { defaultDesired, readDesired } from "./desired.js";
import { featureNames, resolveDesiredFeatures } from "./features.js";
import { manifestPreflight, runDoctor } from "./doctor.js";
import { runVerify } from "./verify.js";
import { readInstallationState } from "../../.pi/harnesses/lib/installation-state.js";

export const INSPECT_SCHEMA_VERSION = 1;

const message = (error) => (error instanceof Error ? error.message : String(error));

function pickItem(item) {
  return {
    id: item.id, kind: item.kind, group: item.group ?? null, title: item.title ?? item.id, state: item.state,
    owned: Boolean(item.owned), recordedMethod: item.recordedMethod ?? null, target: item.target ?? null,
    retired: Boolean(item.retired), detail: item.detail ?? null,
    fileCount: item.fileCount ?? null, changedCount: item.changedCount ?? null,
    changedFiles: (item.files ?? []).map((file) => ({ path: file.path, state: file.state, detail: file.detail ?? null })),
    obsoleteFiles: (item.obsoleteFiles ?? []).length, legacyTargets: item.legacyTargets ?? [],
  };
}

function desiredSection({ workspace, manifest, agent, platform }) {
  const catalogueNames = featureNames(manifest);
  let status = "missing", error = null, desired = null;
  try {
    desired = readDesired(workspace, manifest);
    if (desired) status = "valid";
  } catch (err) { status = "invalid"; error = message(err); }
  const base = desired ?? defaultDesired(manifest);
  const enabled = Object.entries(base.features).filter(([, on]) => on).map(([name]) => name);
  let effective = null, featureError = null;
  try {
    const resolved = resolveDesiredFeatures(manifest, { preset: base.preset, features: enabled, agent, platform });
    effective = { preset: resolved.preset, features: resolved.features, roots: resolved.roots.length, selected: resolved.selected.length };
  } catch (err) { featureError = message(err); }
  const effectiveSet = new Set(effective?.features ?? []);
  const catalogue = catalogueNames.map((name) => {
    const feature = manifest.features[name];
    const featurePlatform = feature.platform ?? "any";
    return {
      name, title: feature.title ?? name, stability: feature.stability ?? "unknown", platform: featurePlatform,
      requiresFeatures: feature.requiresFeatures ?? [], items: feature.items ?? [],
      enabled: enabled.includes(name), effective: effectiveSet.has(name),
      available: featurePlatform === "any" || featurePlatform === platform,
    };
  });
  return {
    status, error, path: ".ai/agent-fleet.json",
    preset: desired?.preset ?? null, enabled, presets: Object.keys(manifest.presets ?? {}),
    effective, featureError, catalogue,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.workspace       absolute workspace root
 * @param {string} opts.sourceRoot      the running package root
 * @param {string} opts.packageVersion  the running package version
 * @param {object} opts.manifest        loaded install manifest
 * @param {string|null} [opts.agent]    resolved agent (pi) or null
 * @param {string} [opts.platform]
 * @param {object} [opts.env]           only read for presence checks inside doctor
 */
export async function runInspect({ workspace, sourceRoot, packageVersion, manifest, agent = null, platform = process.platform, env = process.env }) {
  const sections = {};
  const attempt = async (name, body) => {
    try { sections[name] = await body(); }
    catch (err) { sections[name] = { error: message(err) }; }
  };
  const installation = readInstallationState(workspace);
  await attempt("verify", async () => {
    const report = await runVerify({ workspace, sourceRoot, packageVersion, manifest, agent, platform, includeDoctor: false });
    return {
      agent: report.agent, recordedVersion: report.recordedVersion, stateSource: report.stateSource, baseAvailable: report.baseAvailable,
      summary: report.summary, items: report.items.map(pickItem), findings: report.findings,
    };
  });
  await attempt("doctor", async () => ({
    findings: await runDoctor({ workspace, sourceRoot, env }),
    preflight: manifestPreflight({ workspace, sourceRoot, manifest, state: installation.state ?? null, platform, pathValue: env.PATH }),
  }));
  await attempt("desired", async () => desiredSection({ workspace, manifest, agent: agent ?? "pi", platform }));
  await attempt("provenance", async () => {
    const record = readProjectProvenance(workspace);
    return { status: record.status, error: record.error ?? null, entries: record.state ? Object.keys(record.state.entries).length : 0, path: ".ai/agent-fleet-ai-state.json" };
  });
  return {
    schemaVersion: INSPECT_SCHEMA_VERSION, verb: "inspect", readOnly: true,
    workspace, sourceRoot, packageVersion, platform, agent,
    installation: { status: installation.status, reason: installation.reason ?? null },
    ...sections,
  };
}
