// Explicit, narrowly scoped repair of known retired desired-state features.
import { existsSync, readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DESIRED_FILE, validateDesired } from "./desired.js";
import { retiredFeatureError } from "./features.js";
import { assertSafeWorkspaceTarget } from "./workspace-safety.js";
import { publicRepairPreview } from "./public-plan.js";

export function inspectDesiredRepair(workspace, manifest) {
  const path = assertSafeWorkspaceTarget(workspace, DESIRED_FILE, { allowLeafSymlink: false });
  if (!existsSync(path)) return null;
  const original = readFileSync(path, "utf8");
  let value;
  try { value = JSON.parse(original); }
  catch { throw new Error(`invalid desired config ${DESIRED_FILE}: invalid JSON; manual repair required`); }
  const candidate = structuredClone(value);
  const removed = [];
  if (candidate?.features && typeof candidate.features === "object" && !Array.isArray(candidate.features)) {
    for (const [name, enabled] of Object.entries(candidate.features)) {
      if (!manifest.features?.[name] && retiredFeatureError(name) && typeof enabled === "boolean") {
        removed.push({ name, value: enabled });
        delete candidate.features[name];
      }
    }
  }
  // Never offer a partial repair of an otherwise invalid configuration.
  validateDesired(candidate, manifest);
  if (!removed.length) return null;
  if (!lstatSync(path).isFile()) throw new Error(`cannot repair non-regular config ${DESIRED_FILE}`);
  return { path, original, replacement: JSON.stringify(candidate, null, 2) + "\n", removed };
}

export function describeDesiredRepair(proposal) {
  return `Retired settings found in ${DESIRED_FILE}:\n${proposal.removed.map(({ name, value }) => `- ${JSON.stringify(name)}: ${value}`).join("\n")}\nProposed repair: remove only these settings. Other settings are preserved.\nchatgpt-client will NOT be enabled automatically.\nA backup will be saved before the repair. This repair is separate from the subsequent setup plan.`;
}

export function applyDesiredRepair(proposal) {
  const { path, original, replacement } = proposal;
  const unchanged = () => {
    if (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== original) {
      throw new Error("desired config changed since repair was proposed; rerun setup");
    }
  };
  unchanged();
  const id = randomUUID();
  const backup = `${path}.backup-${id}`;
  const temporary = `${path}.repair-${id}`;
  writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  try {
    writeFileSync(temporary, replacement, { flag: "wx", mode: lstatSync(path).mode & 0o777 });
    unchanged();
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return backup;
}

export async function prepareDesiredRepair({ workspace, manifest, dryRun, approved, interactive, output, confirm }) {
  const proposal = inspectDesiredRepair(workspace, manifest);
  if (!proposal) return { repaired: false };
  if (dryRun) return { repaired: false, preview: publicRepairPreview(proposal) };
  output.write(describeDesiredRepair(proposal) + "\n");
  if (!approved) {
    if (!interactive) throw new Error("Config repair requires explicit approval: rerun setup interactively or with --yes --repair-config. No mutation was applied.");
    const answer = await confirm("Apply this config repair now? yes/y | no/n; Enter = no (cancel; backup is created only after yes) > ");
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) return { repaired: false, cancelled: true };
  }
  const backup = applyDesiredRepair(proposal);
  output.write(`Config repaired. Original saved to ${backup}\n`);
  return { repaired: true, backup };
}
