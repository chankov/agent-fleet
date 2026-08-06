// reconcile.js — desired state × manifest × disk × ownership ledger.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDesiredState, DESIRED_FILE } from "./desired.js";
import { resolveDesiredFeatures } from "./features.js";
import { buildPlan } from "./plan.js";
import { readState } from "./state.js";
import { scanProject } from "./scan.js";
import { planOverrides } from "./overrides.js";
import { appendEnvPlaceholders, renderSttConfig } from "./stt-wizard.js";

/** Build one setup plan. This function writes nothing. */
export function buildReconcilePlan(opts) {
  const { workspace, manifest, sourceRoot, packageVersion, agent = "pi", method,
    preset, features, saveDesired = false, tuiDesired = null, dryRun = false,
    migrate = false, yes = false, accept = null, platform = process.platform } = opts;
  const state = readState(workspace);
  const desiredPath = join(workspace, DESIRED_FILE);
  const firstMigration = Boolean(state && !existsSync(desiredPath));
  const explicitDesired = preset !== undefined && features !== undefined;

  if (migrate && !firstMigration) throw new Error("--migrate is valid only for first-migration workspaces");
  let migrationBlocked = false;
  if (firstMigration && !dryRun && (!migrate || !yes || !explicitDesired)) {
    migrationBlocked = true;
  }

  const desiredResult = resolveDesiredState({ workspace, manifest, preset, features, saveDesired, tuiDesired, dryRun });
  const featureResult = resolveDesiredFeatures(manifest, {
    preset: desiredResult.desired.preset,
    features: Object.entries(desiredResult.desired.features).filter(([, enabled]) => enabled).map(([name]) => name),
    agent, platform,
  });
  const base = buildPlan({ workspace, sourceRoot, packageVersion, manifest, verb: "install", agent,
    method, items: featureResult.roots, accept, platform });
  const wanted = new Set(featureResult.selected);
  const overrides = planOverrides(workspace, scanProject(workspace));
  const sttConfig = featureResult.features.includes("voice")
    ? { provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
    : null;
  const stt = sttConfig ? {
    path: join(workspace, ".ai", "stt.json"), text: renderSttConfig(sttConfig),
    env: appendEnvPlaceholders(workspace, sttConfig),
  } : null;
  const recorded = Object.keys(state?.items ?? {});
  const removals = recorded.filter((id) => !wanted.has(id)).sort().map((id) => ({
    kind: "remove", id, itemKind: state.items[id].kind ?? "unknown", consent: "file", state: "owned",
    owned: true, target: state.items[id].files?.[0]?.path ?? null,
    paths: (state.items[id].files ?? []).map((file) => file.path).sort(),
    reason: "not selected by desired state",
  }));
  // Desired state narrows ownership; no unrecorded/foreign path is ever named.
  const actions = base.actions.filter((action) => !(action.kind === "keep" && !wanted.has(action.id))).concat(removals);
  const conflicts = actions.filter((action) => action.kind === "conflict");
  return {
    ...base, verb: "setup", desired: desiredResult.desired, desiredPath: desiredResult.path,
    writeDesired: desiredResult.writeDesired, firstMigration, migrationBlocked,
    migrationError: migrationBlocked
      ? "first migration requires --migrate --preset <default|full> --features <exact-set> --yes"
      : null,
    selection: { ...base.selection, desired: featureResult, resolved: featureResult.selected },
    actions, conflicts,
    overrides,
    stt,
    summary: { ...base.summary, remove: removals.length, changes: base.summary.changes + removals.length },
  };
}
