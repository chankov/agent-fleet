import { checkScope } from "./scope-gate.js";
import { externalChangedPaths, identifyExternalGit, readExternalHead } from "./proactive-external-git.ts";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { authorizePolicyPath, type PolicyRootTable } from "../lib/policy-roots.ts";
import { safeSourceRead } from "../lib/safe-source-read.js";
import { PROACTIVE_LIMITS } from "./proactive-config.ts";

const coverageGap = (error: unknown): string => {
 const message = (error as Error)?.message;
 if (["capture_timeout", "external_capture_limit", "external_head_changed"].includes(message)) return message;
 if (message === "source_changed") return "external_unstable_snapshot";
 if (message === "state_too_large" || (error as NodeJS.ErrnoException)?.code === "ENOBUFS") return "external_capture_limit";
 return "external_evidence_unavailable";
};
const forbidden = /^(?:\..*|node_modules|vendor|dist|build|coverage|artifacts|sessions?|transcripts?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|db|lock))$/i;
export interface ExternalBaseline {
 readonly roots: PolicyRootTable;
 readonly files: ReadonlyMap<string, Buffer>;
 readonly identities: ReadonlyMap<string, string>;
 readonly gitHeads: ReadonlyMap<string, string>;
 readonly headFiles: ReadonlyMap<string, Buffer>;
 readonly gaps: readonly string[];
}
/** Capture only consented scopes in independent repositories. Never discover repositories recursively. */
export function captureExternal(input: { roots: PolicyRootTable; include: readonly string[]; maxFiles: number; maxBytes: number; check(): void; includeWorkspace?: boolean; knownPaths?: readonly string[] }): ExternalBaseline {
 const files = new Map<string,Buffer>(), identities = new Map<string,string>(), gitHeads = new Map<string,string>(), headFiles = new Map<string,Buffer>(), gaps: string[] = [];
 let bytes = 0, entries = 0;
 const visited = new Set<string>(), changedByRepository = new Map<string, string[]>();
 const read = (path: string) => {
  input.check();
  const admitted = authorizePolicyPath(input.roots,path);
  const lexical = resolve(admitted.root.lexicalPath,relative(admitted.root.canonicalPath,admitted.path));
  const logical = relative(input.roots.workspace,lexical).split(sep).join("/");
  if (!checkScope([logical], input.include).inScope.length || files.has(logical)) return;
  if (!headFiles.has(logical) && new Set([...files.keys(), ...headFiles.keys()]).size >= input.maxFiles) { gaps.push("external_capture_limit"); return; }
  const content = safeSourceRead(admitted.root.kind === "file" ? dirname(admitted.path) : admitted.root.canonicalPath,admitted.path,PROACTIVE_LIMITS.maxFileBytes,input.check);
  if (bytes + content.length > input.maxBytes) { gaps.push("external_capture_limit"); return; }
  files.set(logical,content); identities.set(logical,admitted.root.id); bytes += content.length;
 };
 const scopes = [...new Set(input.include.filter(path => input.includeWorkspace || path.startsWith("../")).map(include => {
  const parts = include.split("/"), glob = parts.findIndex(part => /[*?]/.test(part));
  return glob < 0 ? include : parts.slice(0, glob).join("/");
 }))].sort((a, b) => a.length - b.length || a.localeCompare(b));
 const selected = scopes.filter((scope, index) => !scopes.slice(0, index).some(parent => scope.startsWith(parent + "/")));
 // Group only approved scopes for status, not the entire repository inventory.
 const statusScopes = input.includeWorkspace ? selected.flatMap(scope => {
  if (!scope || scope === "..") return [];
  try {
   const source = authorizePolicyPath(input.roots, scope);
   if (source.root.role === "workspace" && resolve(input.roots.workspace, scope) !== source.path) return [];
   return [source.path];
  } catch { return []; }
 }) : [];
 for (const scope of selected) {
  try {
   input.check();
   if (!scope || scope === "..") throw new Error("unbounded_capture_scope");
   let admitted;
   try { admitted = authorizePolicyPath(input.roots,scope); }
   catch (error) {
    if (!input.includeWorkspace || !(error instanceof Error) || !error.message.startsWith("missing_path:")) throw error;
    // A deleted consented descendant can use HEAD, but only below a live directory grant.
    // Never recover a changed/missing grant itself by falling back to the workspace.
    const target = resolve(input.roots.workspace, scope);
    let parent = dirname(target);
    while (!existsSync(parent) && dirname(parent) !== parent) { input.check(); parent = dirname(parent); }
    const ancestor = authorizePolicyPath(input.roots, parent, "inventory");
    admitted = { root: ancestor.root, path: resolve(ancestor.path, relative(parent, target)) };
   }
   if (admitted.root.role === "workspace" && (!input.includeWorkspace || resolve(input.roots.workspace, scope) !== admitted.path)) throw new Error("unsafe_capture_scope");
   const stat = existsSync(admitted.path) ? lstatSync(admitted.path) : undefined;
   let directory = stat?.isDirectory() ? admitted.path : dirname(admitted.path);
   while (!existsSync(directory) && dirname(directory) !== directory) { input.check(); directory = dirname(directory); }
   const head = identifyExternalGit(directory,input.roots.workspace,input.check);
   let paths: string[] | undefined;
   if (head && input.includeWorkspace) {
    const approved = [...new Set([...statusScopes.filter(path => {
     const rel = relative(head.root, path);
     return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    }), admitted.path])].sort();
    const statusKey = JSON.stringify([head.identity, approved]);
    let changed = changedByRepository.get(statusKey);
    if (!changed) { changed = externalChangedPaths(head, input.check, approved); changedByRepository.set(statusKey, changed); }
    paths = [...new Set([...changed, ...(input.knownPaths ?? []).map(path => resolve(input.roots.workspace, path))])].filter(path => {
     const rel = relative(admitted.path, path);
     const logical = relative(input.roots.workspace, path).split(sep).join("/");
     return (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) &&
      !relative(head.root, path).split(sep).some(part => forbidden.test(part)) && checkScope([logical], input.include).inScope.length;
    });
    if (paths.length > input.maxFiles) throw new Error("external_capture_limit");
   }
   if (head) {
    gitHeads.set(scope,head.identity);
    const retainedHead = readExternalHead({git:head,scope:admitted.path,grant:admitted.root,roots:input.roots,maxFiles:input.maxFiles-new Set([...files.keys(), ...headFiles.keys()]).size,maxBytes:input.maxBytes-bytes,check:input.check,include:input.include,existing:headFiles,paths});
    for (const [path,content] of retainedHead) if (!headFiles.has(path)) { headFiles.set(path,content); identities.set(path,admitted.root.id); bytes+=content.length; }
   } else gaps.push("external_history_unavailable");
   if (paths) {
    for (const path of paths) {
     try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("unsafe_capture_source");
      read(path);
     }
     catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    continue;
   }
   if (!stat) throw new Error("missing_capture_scope");
   if (stat.isFile()) { read(admitted.path); continue; }
   const queue = [admitted.path];
   while (queue.length) {
    input.check();
    const dir = queue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    if (visited.size > PROACTIVE_LIMITS.maxUnits * 4) { gaps.push("external_capture_limit"); break; }
    authorizePolicyPath(input.roots,dir,"inventory");
    const handle = opendirSync(dir), names: string[] = [];
    try {
     let entry;
     while ((entry=handle.readSync()) !== null) {
      input.check();
      if (++entries > PROACTIVE_LIMITS.maxUnits * 16) { gaps.push("external_capture_limit"); break; }
      if (!forbidden.test(entry.name)) names.push(entry.name);
     }
    } finally { handle.closeSync(); }
    for (const name of names.sort()) {
     const path = join(dir,name), stat = lstatSync(path);
     if (stat.isSymbolicLink()) continue;
     try {
      authorizePolicyPath(input.roots,path);
      if (stat.isDirectory()) queue.push(path); else if (stat.isFile()) read(path);
     } catch (error) { gaps.push(coverageGap(error)); }
    }
    if (entries > PROACTIVE_LIMITS.maxUnits * 16) break;
   }
  } catch (error) { gaps.push(coverageGap(error)); }
 }
 return { roots:input.roots,files,identities,gitHeads,headFiles,gaps:[...new Set(gaps)] };
}
