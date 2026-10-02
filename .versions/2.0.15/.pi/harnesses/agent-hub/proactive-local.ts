import { createHash } from "node:crypto";
import { posix } from "node:path";
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
const safeRulePath = (path: unknown): path is string => typeof path === "string" && path.startsWith(".ai/") ? safePath(path.slice(4)) : safePath(path);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => k in v);
const paths = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(safePath) && new Set(v).size === v.length;
const safeBasename = (v: unknown): v is string => typeof v === "string" && safePath(v) && !v.includes("/") && !v.includes("*") && !v.includes("?");
export function parseLocalBindings(value: unknown): readonly ReviewedLocalBinding[] {
 if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid local bindings");
 return Object.freeze(value.map((item: unknown) => {
  if (!exact(item, ["version", "validator", "rule", "applicability", "exceptions", "placement"]) && !exact(item, ["version", "validator", "rule", "applicability", "exceptions"])) throw new Error("Invalid local binding schema");
  const b = item as unknown as ReviewedLocalBinding;
  if (b.version !== 1 || !["relative-markdown-links", "new-file-placement"].includes(b.validator) ||
   !exact(b.rule, ["path", "heading", "occurrence", "hash"]) || !safeRulePath(b.rule.path) || !b.rule.path.endsWith(".md") ||
   typeof b.rule.heading !== "string" || !b.rule.heading.trim() || b.rule.heading.length > 200 || !Number.isSafeInteger(b.rule.occurrence) || b.rule.occurrence < 1 || !/^[a-f0-9]{64}$/.test(b.rule.hash) ||
   (!exact(b.applicability, ["paths", "kinds"]) && !exact(b.applicability, ["paths", "kinds", "basename"])) || (b.applicability.basename !== undefined && (!safeBasename(b.applicability.basename) || !b.applicability.paths.includes(b.applicability.basename))) || !paths(b.applicability.paths) || !b.applicability.paths.length || !Array.isArray(b.applicability.kinds) || !b.applicability.kinds.length || new Set(b.applicability.kinds).size !== b.applicability.kinds.length || !b.applicability.kinds.every(k => k === "added" || k === "modified") ||
   !exact(b.exceptions, ["paths", "legacy"]) || !paths(b.exceptions.paths) || typeof b.exceptions.legacy !== "boolean" ||
   (b.validator === "new-file-placement" ? !exact(b.placement, ["prefix"]) || !safePath(b.placement.prefix) || b.applicability.kinds.some(k => k !== "added") : b.placement !== undefined)) throw new Error("Invalid local binding values");
  return Object.freeze({ version: 1 as const, validator: b.validator, rule: Object.freeze({ ...b.rule }), applicability: Object.freeze({ paths: Object.freeze([...b.applicability.paths]), kinds: Object.freeze([...b.applicability.kinds]), ...(b.applicability.basename === undefined ? {} : { basename: b.applicability.basename }) }), exceptions: Object.freeze({ paths: Object.freeze([...b.exceptions.paths]), legacy: b.exceptions.legacy }), ...(b.placement ? { placement: Object.freeze({ ...b.placement }) } : {}) });
 }));
}
const matches = (path: string, patterns: readonly string[]) => patterns.some(p => p.endsWith("/**") ? path.startsWith(p.slice(0, -3) + "/") : path === p);
// Only an explicitly named basename in the reviewed paths can match across captured include-authorized directories.
const appliesTo = (path: string, applicability: ReviewedLocalBinding["applicability"]) =>
 (!applicability.basename || posix.basename(path) === applicability.basename) &&
 (matches(path, applicability.paths) || (applicability.basename !== undefined && applicability.paths.includes(applicability.basename)));
/** Pure snapshot check: no filesystem lookup, test/build launch, scripts, or prose-derived regex. */
export function assessLocal(snapshot: TurnSnapshot, sections: readonly CatalogSection[], bindings: readonly ReviewedLocalBinding[], included?: readonly string[]): LocalAssessment {
 const findings: LocalFinding[] = [], gaps: string[] = [];
 for (const b of bindings) {
  const section = sections.find(s => s.source.path === b.rule.path && s.heading === b.rule.heading && s.occurrence === b.rule.occurrence && s.source.hash === b.rule.hash);
  if (!section || !snapshot.context.rules.some(r => r.path === b.rule.path && r.hash === b.rule.hash)) { gaps.push(`unverified_binding:${b.rule.path}#${b.rule.heading}@${b.rule.occurrence}`); continue; }
  for (const unit of snapshot.units) {
   if (!b.applicability.kinds.includes(unit.kind as "added" | "modified") || !safePath(unit.path) || (included && !matches(unit.path, included)) || !appliesTo(unit.path, b.applicability) || matches(unit.path, b.exceptions.paths) || (b.exceptions.legacy && unit.kind !== "added")) continue;
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
      if (!decoded || decoded.startsWith("/") || decoded.includes("\\") || posix.normalize(posix.join(posix.dirname(unit.path), decoded)).startsWith("../")) emit(offset + m.index!);
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
