import { createHash } from "node:crypto";
import { posix, relative, resolve } from "node:path";
import { authorizePolicyPath, type PolicyRootTable } from "../lib/policy-roots.ts";
import type { CatalogSection } from "./proactive-rules.ts";
import type { ReviewFinding, TurnSnapshot } from "./proactive-types.ts";

/** Operator-reviewed data, not a grammar for interpreting rule prose. No real bindings ship. */
export interface ReviewedLocalBinding {
 readonly version: 1;
 readonly validator: "relative-markdown-links" | "new-file-placement";
 readonly rule: { readonly path: string; readonly heading: string; readonly occurrence: number; readonly hash: string };
 readonly applicability: { readonly paths: readonly string[]; readonly kinds: readonly ("added" | "modified")[]; readonly basename?: string };
 readonly exceptions: { readonly paths: readonly string[]; readonly legacy: boolean };
 readonly placement?: { readonly prefix: string };
}
export interface LocalFinding extends ReviewFinding {
 readonly locator: { readonly path: string; readonly excerptHash: string; readonly line?: number; readonly column?: number; readonly byteOffset?: number }; // placement is path-only, never an invented line
 readonly ruleHash: string;
 readonly category: ReviewedLocalBinding["validator"];
}
export interface LocalAssessment { readonly findings: readonly LocalFinding[]; readonly gaps: readonly string[] }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const safePath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 256 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && path.split("/").every(s => !!s && s !== "." && s !== ".." && !s.startsWith("."));
export { parseLocalBindings } from "../lib/system1/config-proactive.js";
const matches = (path: string, patterns: readonly string[]) => patterns.some(p => p.endsWith("/**") ? path.startsWith(p.slice(0, -3) + "/") : path === p || (p.startsWith("../") && path.startsWith(p+"/")));
// Only an explicitly named basename in the reviewed paths can match across captured include-authorized directories.
const appliesTo = (path: string, applicability: ReviewedLocalBinding["applicability"]) =>
 (!applicability.basename || posix.basename(path) === applicability.basename) &&
 (matches(path, applicability.paths) || (applicability.basename !== undefined && applicability.paths.includes(applicability.basename)));
/** Pure snapshot check: no filesystem lookup, test/build launch, scripts, or prose-derived regex. */
export function assessLocal(snapshot: TurnSnapshot, sections: readonly CatalogSection[], bindings: readonly ReviewedLocalBinding[], included?: readonly string[], roots?: PolicyRootTable): LocalAssessment {
 const findings: LocalFinding[] = [], gaps: string[] = [];
 for (const b of bindings) {
  const candidates = sections.filter(s => s.source.path === b.rule.path);
  const sources = new Set(candidates.map(s => s.source.rootId ?? s.source.physicalPath ?? s.source.path));
  if (sources.size > 1 || candidates.some(s => s.source.bindingAmbiguous)) {
   gaps.push(`ambiguous_binding:${b.rule.path}`); continue;
  }
  const section = candidates.find(s => s.heading === b.rule.heading && s.occurrence === b.rule.occurrence && s.source.hash === b.rule.hash);
  if (!section || !snapshot.context.rules.some(r => r.path === b.rule.path && r.hash === b.rule.hash && r.rootId === section.source.rootId && r.physicalPath === section.source.physicalPath && !r.bindingAmbiguous)) { gaps.push(`unverified_binding:${b.rule.path}#${b.rule.heading}@${b.rule.occurrence}`); continue; }
  for (const unit of snapshot.units) {
   let policyPath = unit.path;
   if (unit.path.startsWith("../")) {
    if (!roots || !unit.sourceRootId || !included || !matches(unit.path,included)) continue;
    const root = roots.roots.find(r=>r.id===unit.sourceRootId);
    if (!root) continue;
    policyPath = root.kind === "file" ? posix.basename(unit.path) : relative(root.lexicalPath,resolve(roots.workspace,unit.path)).split("\\").join("/");
    if (!safePath(policyPath)) continue;
   }
   if (!b.applicability.kinds.includes(unit.kind as "added" | "modified") || !safePath(policyPath) || (included && !matches(unit.path, included)) || !appliesTo(policyPath, b.applicability) || matches(policyPath, b.exceptions.paths) || (b.exceptions.legacy && unit.kind !== "added")) continue;
   if (/\.(?:cs|vue)$/i.test(unit.path)) gaps.push(`needs_review:unsupported_semantics:${unit.id}`);
   if (b.validator === "relative-markdown-links" && !unit.path.toLowerCase().endsWith(".md")) { gaps.push(`not_applicable:${unit.id}`); continue; }
   const after = unit.after;
   if (!after || after.truncated || after.offset !== 0 || digest(after.text) !== after.hash || after.endOffset !== Buffer.byteLength(after.text) || snapshot.status !== "complete") { gaps.push(`unverified_locator:${unit.id}`); continue; }
   const emit = (index?: number) => {
    const previous = index === undefined ? undefined : after.text.slice(0, index);
    const position = previous === undefined ? {} : { line: previous.split("\n").length, column: [...previous.slice(previous.lastIndexOf("\n") + 1)].length + 1, byteOffset: Buffer.byteLength(previous) };
    findings.push({ source: "deterministic", snapshotId: snapshot.snapshotId, unitId: unit.id, reference: section.id, ruleHash: b.rule.hash, category: b.validator, verdict: "potential_violation", evidenceStatus: snapshot.status, delivery: "not_applicable", locator: { path: unit.path, excerptHash: after.hash, ...position } });
   };
   if (b.validator === "new-file-placement") {
    if (unit.kind === "added" && !unit.path.startsWith(b.placement!.prefix + "/")) emit();
    continue;
   }
   let fenced = false, offset = 0, unchecked = false;
   for (const line of after.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; offset += line.length; continue; }
    if (!fenced && !/^\s{4}/.test(line)) {
     const withoutInline = line.replace(/`+[^`]*`+/g, m => " ".repeat(m.length));
     for (const m of withoutInline.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const target = m[1]!;
      if (target.startsWith("<")) { unchecked = true; continue; } // angle destination is not this inline-path check
      if (/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(target)) continue; // external and in-document links are not local paths
      const decoded = (() => { try { return decodeURIComponent(target.split("#")[0]!); } catch { return ""; } })();
      let admitted = false;
      if (roots && decoded && !decoded.startsWith("/") && !decoded.includes("\\")) {
       try { authorizePolicyPath(roots,resolve(roots.workspace,posix.dirname(unit.path),decoded)); admitted = true; } catch { /* ungranted link stays a violation */ }
      }
      if (!decoded || decoded.startsWith("/") || decoded.includes("\\") || (!admitted && posix.normalize(posix.join(posix.dirname(unit.path), decoded)).startsWith("../"))) emit(offset + m.index!);
     }
     const remaining = withoutInline.replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ");
     if (/\[[^\]\n]*\]\[/.test(remaining) || /^\s{0,3}\[[^\]\n]+\]:/.test(remaining) || /\[[^\]\n]+\]/.test(remaining)) unchecked = true;
    }
    offset += line.length;
   }
   if (unchecked) gaps.push(`unchecked_link:${unit.id}`);
  }
 }
 return { findings, gaps };
}
