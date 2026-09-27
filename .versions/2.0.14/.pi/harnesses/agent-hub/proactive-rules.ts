import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BoundReference, RuleSection } from "./proactive-types.ts";

export const RULE_CATALOG_LIMITS = Object.freeze({ files: 64, bytes: 256 * 1024 });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const denied = /^(?:\.git|\.pi|node_modules|vendor|dist|build|coverage|\.env(?:\..*)?|credentials?|secrets?)$/i;
export interface CatalogSection extends RuleSection {
 readonly text: string; // complete subtree, with all nested exceptions and examples
 readonly context: string; // complete ancestor introductions, outermost first
 readonly kind: "default" | "shared" | "conditional" | "reference";
}
export interface RuleCatalog {
 readonly sections: readonly CatalogSection[];
 readonly files: readonly BoundReference[];
 readonly gaps: readonly string[];
 readonly status: "complete" | "partial";
 readonly bytesRead: number;
 readonly version: string;
}

/** Local catalog only. Never interprets Markdown as commands or authority. */
export function discoverRules(repo: string, roots: readonly string[]): RuleCatalog {
 const sections: CatalogSection[] = [], files: BoundReference[] = [], gaps: string[] = [];
 let bytesRead = 0;
 const seen = new Set<string>(), queued = new Set<string>();
 const repoReal = realpathSync(repo);
 const inside = (base: string, target: string) => target === base || target.startsWith(base + sep);
 const relativePath = (p: string) => relative(repoReal, p).split(sep).join("/");
 for (const root of roots) {
  if (!root || isAbsolute(root) || root.split(/[\\/]/).some(s => !s || s === ".." || s === "." || denied.test(s))) { gaps.push("invalid_root"); continue; }
  let rootReal: string;
  try { rootReal = realpathSync(resolve(repoReal, root)); } catch { gaps.push(`missing_root:${root}`); continue; }
  if (!inside(repoReal, rootReal) || !statSync(rootReal).isDirectory()) { gaps.push(`unsafe_root:${root}`); continue; }
  const queue: string[] = [];
  const enqueue = (p: string) => { if (!queued.has(p)) { queued.add(p); queue.push(p); } };
  const safe = (p: string): string | null => {
   if (!inside(rootReal, p) || relative(rootReal, p).split(sep).some(s => denied.test(s))) return null;
   try { const real = realpathSync(p); return inside(rootReal, real) && inside(repoReal, real) ? real : null; } catch { return null; }
  };
  const walk = (dir: string) => {
   // Bound the directory traversal too; symlink cycles cannot grow the queue indefinitely.
   const dirs = [dir], visited = new Set<string>();
   while (dirs.length) {
    const next = dirs.shift()!;
    const real = safe(next);
    if (!real || visited.has(real)) { if (!real) gaps.push(`unsafe_path:${relativePath(next)}`); continue; }
    visited.add(real);
    if (visited.size > RULE_CATALOG_LIMITS.files || queued.size > RULE_CATALOG_LIMITS.files * 4) { gaps.push("discovery_directory_budget"); break; }
    const entries: import("node:fs").Dirent[] = [];
    try {
     const handle = opendirSync(next);
     try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
       if (entries.length >= RULE_CATALOG_LIMITS.files * 4) { gaps.push("discovery_directory_budget"); break; }
       entries.push(entry);
      }
     } finally { handle.closeSync(); }
     entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch { gaps.push(`unreadable_directory:${relativePath(next)}`); continue; }
    for (const e of entries) {
     if (denied.test(e.name)) continue;
     const p = join(next, e.name), checked = safe(p);
     if (!checked) { if (e.isSymbolicLink()) gaps.push(`unsafe_path:${relativePath(p)}`); continue; }
     let stat;
     try { stat = statSync(p); } catch { gaps.push(`unreadable_path:${relativePath(p)}`); continue; }
     if (stat.isDirectory()) dirs.push(p);
     else if (stat.isFile() && e.name.toLowerCase().endsWith(".md")) enqueue(p);
    }
    if (dirs.length + queued.size > RULE_CATALOG_LIMITS.files * 4) { gaps.push("discovery_directory_budget"); break; }
   }
  };
  const index = ["README.md", "index.md", "INDEX.md"].map(n => join(rootReal, n)).find(p => safe(p));
  if (index) enqueue(index);
  else { gaps.push(`missing_index:${root}`); walk(rootReal); }
  let fallback = false;
  while (queue.length || !fallback) {
   if (!queue.length) { fallback = true; walk(rootReal); if (!queue.length) break; }
   const p = queue.shift()!, real = safe(p);
   if (!real) { gaps.push(`unresolved_reference:${relativePath(p)}`); continue; }
   if (seen.has(real)) continue;
   if (files.length >= RULE_CATALOG_LIMITS.files) { gaps.push("file_budget"); break; }
   let text: string;
   try {
    const fd = openSync(p, "r");
    try {
     const size = fstatSync(fd).size;
     if (size > RULE_CATALOG_LIMITS.bytes - bytesRead) { gaps.push(`byte_budget:${relativePath(p)}`); seen.add(real); continue; }
     const buffer = Buffer.alloc(size + 1);
     let count = 0, n: number;
     while (count < buffer.length && (n = readSync(fd, buffer, count, buffer.length - count, count)) > 0) count += n;
     if (count !== size) { gaps.push(`unstable_file:${relativePath(p)}`); seen.add(real); continue; }
     text = buffer.subarray(0, count).toString("utf8");
     if (!Buffer.from(text).equals(buffer.subarray(0, count))) { gaps.push(`invalid_encoding:${relativePath(p)}`); seen.add(real); continue; }
     bytesRead += count;
    } finally { closeSync(fd); }
   } catch { gaps.push(`unreadable_file:${relativePath(p)}`); seen.add(real); continue; }
   seen.add(real);
   const path = relativePath(p), digest = hash(text);
   const source: BoundReference = { path, hash: digest, revision: digest };
   files.push(source);
   const lines = text.split(/(?<=\n)/), starts: number[] = [], headings: { index: number; level: number; title: string; occurrence: number }[] = [];
   const occurrences = new Map<string, number>();
   let offset = 0, fence = false;
   for (const line of lines) {
    starts.push(offset); offset += line.length;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const match = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*(?:\r?\n)?$/.exec(line);
    if (match) {
     const title = match[2]!.trim(), occurrence = (occurrences.get(title) ?? 0) + 1;
     occurrences.set(title, occurrence);
     headings.push({ index: starts.length - 1, level: match[1]!.length, title, occurrence });
    }
   }
   if (!headings.length) headings.push({ index: 0, level: 0, title: "(document)", occurrence: 1 });
   for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const end = headings.slice(i + 1).find(x => x.level <= h.level);
    const own = text.slice(starts[h.index], end ? starts[end.index] : text.length);
    const parents = headings.slice(0, i).filter(x => x.level < h.level && !headings.slice(headings.indexOf(x) + 1, i).some(y => y.level <= x.level));
    const context = parents.map(x => {
     const next = headings.find(y => y.index > x.index && y.level > x.level);
     return text.slice(starts[x.index], next ? starts[next.index] : text.length);
    }).join("\n");
    const label = `${path}#${h.title}@${h.occurrence}`;
    const kind = /default/i.test(path + " " + h.title) ? "default" : /shared/i.test(path + " " + h.title) ? "shared" : /conditional|when|if\b/i.test(h.title) ? "conditional" : "reference";
    sections.push({ id: `${label}:${hash(own)}`, source, heading: h.title, occurrence: h.occurrence, text: own, context, kind });
   }
   // Only explicit Markdown links or literal .md references; missing/unsafe paths stay visible.
   const refs = [...text.matchAll(/(?:\]\(|(?:^|[\s`]))([^\s()<>'"`]+\.md)(?:#[^\s)]*)?\)?/gim)];
   for (const match of refs) {
    const target = match[1]!;
    if (/^[a-z]+:/i.test(target) || target.startsWith("/") || target.includes("\\")) { gaps.push(`unresolved_reference:${path}`); continue; }
    const next = resolve(dirname(p), target);
    if (!safe(next)) { gaps.push(`unresolved_reference:${path}:${target}`); continue; }
    enqueue(next);
   }
  }
 }
 return { sections, files, gaps, status: gaps.length ? "partial" : "complete", bytesRead, version: hash(JSON.stringify({ files, gaps, sections: sections.map(s => s.id) })) };
}
