import { identifyExternalGit, readExternalHead } from "./proactive-external-git.ts";
import { lstatSync, opendirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { authorizePolicyPath, type PolicyRootTable } from "../lib/policy-roots.ts";
import { safeSourceRead } from "../lib/safe-source-read.js";
import { PROACTIVE_LIMITS } from "./proactive-config.ts";

const forbidden = /^(?:\..*|node_modules|vendor|dist|build|coverage|artifacts|sessions?|transcripts?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|db|lock))$/i;
export interface ExternalBaseline {
 readonly roots: PolicyRootTable;
 readonly files: ReadonlyMap<string, Buffer>;
 readonly identities: ReadonlyMap<string, string>;
 readonly gitHeads: ReadonlyMap<string, string>;
 readonly headFiles: ReadonlyMap<string, Buffer>;
 readonly gaps: readonly string[];
}
/** Capture only consented external scopes. No writes, parent inventory, symlink traversal or remote transport. */
export function captureExternal(input: { roots: PolicyRootTable; include: readonly string[]; maxFiles: number; maxBytes: number; check(): void }): ExternalBaseline {
 const files = new Map<string,Buffer>(), identities = new Map<string,string>(), gitHeads = new Map<string,string>(), headFiles = new Map<string,Buffer>(), gaps: string[] = [];
 let bytes = 0, entries = 0;
 const visited = new Set<string>();
 const read = (path: string) => {
  input.check();
  const admitted = authorizePolicyPath(input.roots,path);
  const lexical = resolve(admitted.root.lexicalPath,relative(admitted.root.canonicalPath,admitted.path));
  const logical = relative(input.roots.workspace,lexical).split(sep).join("/");
  if (files.has(logical)) return;
  if (files.size >= input.maxFiles) { gaps.push("external_capture_limit"); return; }
  const content = safeSourceRead(admitted.root.kind === "file" ? dirname(admitted.path) : admitted.root.canonicalPath,admitted.path,PROACTIVE_LIMITS.maxFileBytes,input.check);
  if (bytes + content.length > input.maxBytes) { gaps.push("external_capture_limit"); return; }
  files.set(logical,content); identities.set(logical,admitted.root.id); bytes += content.length;
 };
 for (const include of input.include.filter(path=>path.startsWith("../"))) {
  try {
   input.check();
   const scope = include.endsWith("/**") ? include.slice(0,-3) : include;
   const admitted = authorizePolicyPath(input.roots,scope);
   if (admitted.root.role === "workspace") throw new Error();
   const stat = lstatSync(admitted.path);
   const head = identifyExternalGit(stat.isDirectory() ? admitted.path : dirname(admitted.path),input.roots.workspace,input.check);
   if (head) {
    gitHeads.set(scope,head.identity);
    const retainedHead = readExternalHead({git:head,scope:admitted.path,grant:admitted.root,roots:input.roots,maxFiles:input.maxFiles-headFiles.size,maxBytes:input.maxBytes-bytes,check:input.check});
    for (const [path,content] of retainedHead) if (!headFiles.has(path)) { headFiles.set(path,content); identities.set(path,admitted.root.id); bytes+=content.length; }
   } else gaps.push("external_history_unavailable");
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
     } catch { gaps.push("external_evidence_unavailable"); }
    }
    if (entries > PROACTIVE_LIMITS.maxUnits * 16) break;
   }
  } catch { gaps.push("external_evidence_unavailable"); }
 }
 return { roots:input.roots,files,identities,gitHeads,headFiles,gaps:[...new Set(gaps)] };
}
