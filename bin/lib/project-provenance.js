// Provenance for accepted project AI content; never installer ownership.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashFile, hashText } from "./state.js";
import { runTransaction } from "./transaction.js";
import { assertSafeWorkspaceTarget } from "./workspace-safety.js";

export const AI_STATE_REL_PATH = ".ai/agent-fleet-ai-state.json";
export const AI_STATE_VERSION = 1;
export function templateSource(templateId, sourceVersion, templateBytes) {
  return { origin: "template", templateId, sourceVersion, sourceHash: hashText(templateBytes) };
}
const ROOTS = ["rules", "commands", "agent-prompts"];
const HEX = /^[a-f0-9]{64}$/;
const own = (value) => Object.hasOwn(value, "origin") && ["template", "repo-derived"].includes(value.origin);

export function projectPath(workspace, path) {
  if (typeof path !== "string" || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..") ||
      !ROOTS.some((root) => path.startsWith(`.ai/${root}/`) && path.length > root.length + 5)) throw new Error(`invalid project AI path: ${path}`);
  return assertSafeWorkspaceTarget(workspace, path, { allowLeafSymlink: false });
}

// The source is the installed npm package, never a .pi/ copy or a download.
export function requirePackageCatalogue(packageRoot) {
  for (const root of ROOTS) {
    const path = join(packageRoot, "catalog", root); // catalog/rules, catalog/commands, catalog/agent-prompts
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`installed Fleet npm package is missing catalog/${root}; install a package with the catalogue before setup`);
  }
  return join(packageRoot, "catalog");
}

function validEntry(workspace, path, entry) {
  projectPath(workspace, path);
  if (!entry || !own(entry) || !HEX.test(entry.appliedHash) || !Array.isArray(entry.evidence) ||
      !entry.evidence.every((x) => typeof x === "string" && x.length > 0) ||
      typeof entry.acceptedDecision !== "string" || !entry.acceptedDecision.trim() ||
      (entry.inputs !== undefined && (typeof entry.inputs !== "object" || entry.inputs === null || Array.isArray(entry.inputs)))) return false;
  if (entry.origin === "template") return typeof entry.templateId === "string" && !!entry.templateId &&
    typeof entry.sourceVersion === "string" && !!entry.sourceVersion && HEX.test(entry.sourceHash);
  return !["templateId", "sourceVersion", "sourceHash"].some((key) => Object.hasOwn(entry, key));
}

/** Invalid/corrupt records never authorize overwrite. */
export function readProjectProvenance(workspace) {
  const path = assertSafeWorkspaceTarget(workspace, AI_STATE_REL_PATH, { allowLeafSymlink: false });
  if (!existsSync(path)) return { status: "missing", state: null };
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state.schemaVersion !== AI_STATE_VERSION || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries) ||
      !Object.entries(state.entries).every(([key, entry]) => validEntry(workspace, key, entry))) throw new Error("invalid provenance schema");
    return { status: "valid", state };
  } catch (error) { return { status: "corrupt", state: null, error: error.message }; }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** source: template identity/version/hash, or {origin:'repo-derived'}; inputs are relevant generation inputs. */
export function classifyProjectFile({ workspace, path, source, evidence, acceptedDecision, inputs = {}, knownTemplate = true, snapshotAvailable = false }) {
  const target = projectPath(workspace, path);
  const record = readProjectProvenance(workspace);
  if (record.status !== "valid") return { status: "unknown", reason: record.status };
  const previous = record.state.entries[path];
  if (!previous) return { status: "unknown", reason: "unrecorded" };
  if (!existsSync(target) || !lstatSync(target).isFile()) return { status: "deleted" };
  if (previous.origin === "template" && !knownTemplate) return { status: "unknown", reason: "unknown-template" };
  const local = hashFile(target) !== previous.appliedHash;
  const changed = !source || previous.origin !== source.origin ||
    (source.origin === "template" && ["templateId", "sourceVersion", "sourceHash"].some((key) => source[key] !== previous[key])) ||
    !same(previous.evidence, evidence) || previous.acceptedDecision !== acceptedDecision || !same(previous.inputs ?? {}, inputs);
  return { status: local ? (changed ? "conflict" : "local-edit") : (changed ? "source-update" : "unchanged"),
    snapshotAvailable: !!snapshotAvailable, appliedHash: previous.appliedHash };
}

/** Only an already reviewed, accepted change may be written. Generator is not invoked for an unchanged rerun. */
export function applyAcceptedProjectFiles({ workspace, changes, generateContent, failAt = null }) {
  if (!Array.isArray(changes) || !changes.length) return { changed: false };
  const record = readProjectProvenance(workspace);
  if (record.status === "corrupt") throw new Error("provenance is corrupt; repair before apply");
  const state = record.state ?? { schemaVersion: AI_STATE_VERSION, entries: {} };
  const seen = new Set();
  const prepared = [];
  const sidecar = assertSafeWorkspaceTarget(workspace, AI_STATE_REL_PATH, { allowLeafSymlink: false });
  const sidecarHash = hashFile(sidecar);
  for (const change of changes) {
    const { path, source, evidence, acceptedDecision, inputs = {}, accepted = false, requestChange = false } = change;
    projectPath(workspace, path);
    if (seen.has(path)) throw new Error(`duplicate project AI path: ${path}`);
    seen.add(path);
    const entry = { origin: source?.origin, ...(source?.origin === "template" ? {
      templateId: source.templateId, sourceVersion: source.sourceVersion, sourceHash: source.sourceHash,
    } : {}), evidence, acceptedDecision, inputs, appliedHash: "0".repeat(64) };
    if (!validEntry(workspace, path, entry)) throw new Error(`invalid provenance entry: ${path}`);
    const classification = classifyProjectFile({ workspace, path, source, evidence, acceptedDecision, inputs, knownTemplate: change.knownTemplate });
    if (classification.status === "unchanged" && !requestChange) continue;
    if (!accepted) throw new Error(`${path}: ${classification.status}; explicit acceptance required`);
    if (!["unchanged", "source-update"].includes(classification.status) && !change.adopt && !change.reconciled)
      throw new Error(`${path}: ${classification.status}; adoption or reconciliation required`);
    if (classification.status === "unknown" && classification.reason === "corrupt") throw new Error("corrupt provenance");
    const bytes = change.content === undefined ? generateContent?.(change) : change.content;
    if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) throw new Error(`missing accepted content: ${path}`);
    entry.appliedHash = hashText(bytes);
    prepared.push({ path, bytes, entry, priorHash: hashFile(projectPath(workspace, path)) });
  }
  if (!prepared.length) return { changed: false };
  const plan = { workspace, verb: "configure", actions: [{ files: prepared.map(({ path }) => ({ path })).concat({ path: AI_STATE_REL_PATH }) }] };
  return runTransaction({ workspace, plan, manifest: { items: [] }, failAt, validate: () => {
    if (hashFile(sidecar) !== sidecarHash || prepared.some(({ path, priorHash }) => hashFile(projectPath(workspace, path)) !== priorHash))
      throw new Error("project AI files changed since review; re-run setup");
  }, commit: () => {
    const entries = { ...state.entries };
    for (const { path, bytes, entry } of prepared) {
      const target = projectPath(workspace, path);
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
      if (hashFile(target) !== entry.appliedHash) throw new Error(`readback mismatch: ${path}`);
      entries[path] = entry;
    }
    mkdirSync(dirname(sidecar), { recursive: true }); writeFileSync(sidecar, JSON.stringify({ schemaVersion: AI_STATE_VERSION, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + "\n");
    return { changed: true };
  } });
}
