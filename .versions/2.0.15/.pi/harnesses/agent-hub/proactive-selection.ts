import { createHash } from "node:crypto";
import type { ProactiveConfig } from "./proactive-types.ts";
import type { CatalogSection, RuleCatalog } from "./proactive-rules.ts";

export const SELECTION_VERSION = "p3-selection-v1";
export type SelectionDecision = "applicable" | "not_applicable" | "uncertain";
export interface SelectionInput {
 readonly catalog: RuleCatalog;
 readonly config: ProactiveConfig;
 readonly taskRevision: string;
 readonly changedPaths: readonly string[];
 readonly contentHints: readonly string[];
 readonly maxSections?: number;
 readonly maxBytes?: number;
 readonly classify?: (candidates: readonly { id: string; heading: string; kind: CatalogSection["kind"] }[]) => Promise<Readonly<Record<string, SelectionDecision>>>;
 readonly cache?: Map<string, SelectionResult>;
}
export interface SelectionResult {
 readonly selected: readonly CatalogSection[];
 readonly coverage: readonly { id: string; status: "selected" | "not_selected"; reason: "applicable" | "uncertain" | "default" | "budget" | "provisional_not_applicable" }[];
 readonly gaps: readonly string[];
 readonly status: "complete" | "partial";
 readonly cacheKey: string;
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Model output is only a provisional classification of the already discovered IDs. */
export async function selectRules(input: SelectionInput): Promise<SelectionResult> {
 const { catalog, config } = input;
 const cacheKey = sha([SELECTION_VERSION, input.taskRevision, input.changedPaths, input.contentHints, catalog.version,
  catalog.files.map(f => [f.path, f.hash]), catalog.sections.map(s => [s.id, s.source.hash, sha([s.text, s.context])]),
  config.mode, config.remoteContext, input.maxSections, input.maxBytes]);
 const cached = input.cache?.get(cacheKey);
 if (cached) return cached;
 const gaps = [...catalog.gaps];
 const candidates = catalog.sections;
 let decisions: Readonly<Record<string, SelectionDecision>> = {};
 if (config.mode !== "off" && config.remoteContext === "selected-excerpts" && input.classify && candidates.length) {
  const manifest = candidates.map(s => ({ id: s.id, heading: s.heading, kind: s.kind }));
  if (Buffer.byteLength(JSON.stringify(manifest)) > 32 * 1024) gaps.push("selection_state_budget");
  else try {
   const response = await input.classify(manifest);
   if (!response || Object.keys(response).some(id => !candidates.some(s => s.id === id) || !["applicable", "not_applicable", "uncertain"].includes(response[id]!))) gaps.push("invalid_selection_response");
   else decisions = response;
  } catch { gaps.push("selection_unavailable"); }
 }
 const priority = { default: 0, shared: 1, conditional: 2, reference: 3 };
 const sorted = [...candidates].sort((a, b) => priority[a.kind] - priority[b.kind] || a.source.path.localeCompare(b.source.path) || a.id.localeCompare(b.id));
 const selected: CatalogSection[] = [], coverage: SelectionResult["coverage"][number][] = [];
 let bytes = 0;
 const limit = Math.max(0, Math.min(20, input.maxSections ?? 20));
 const byteLimit = Math.max(0, Math.min(32 * 1024, input.maxBytes ?? 32 * 1024));
 for (const section of sorted) {
  const decision = decisions[section.id];
  if (decision === "not_applicable" && section.kind !== "default" && section.kind !== "shared") {
   coverage.push({ id: section.id, status: "not_selected", reason: "provisional_not_applicable" }); continue;
  }
  // Include full subtree and ancestors or not at all. Never truncate an exception.
  const size = Buffer.byteLength(section.text + section.context);
  if (selected.length >= limit || bytes + size > byteLimit) {
   coverage.push({ id: section.id, status: "not_selected", reason: "budget" }); gaps.push(`selection_budget:${section.id}`); continue;
  }
  selected.push(section); bytes += size;
  coverage.push({ id: section.id, status: "selected", reason: section.kind === "default" || section.kind === "shared" ? "default" : decision === "applicable" ? "applicable" : "uncertain" });
 }
 const result: SelectionResult = { selected, coverage, gaps, status: gaps.length || coverage.some(c => c.status !== "selected") ? "partial" : "complete", cacheKey };
 input.cache?.set(cacheKey, result);
 return result;
}
