import { checkScope } from "./scope-gate.js";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { authorizePolicyPath, type PolicyRoot } from "../lib/policy-roots.ts";
import type { PolicyRootTable } from "../lib/policy-roots.ts";
import { PROACTIVE_LIMITS } from "./proactive-config.ts";

const forbidden = /^(?:\..*|node_modules|vendor|dist|build|coverage|artifacts|sessions?|transcripts?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|db|lock))$/i;
export interface ExternalGitScope { readonly root: string; readonly head: string; readonly identity: string }
function git(root: string, args: string[], check: () => void, maxBuffer = 4096): Buffer {
 check();
 const result = execFileSync("git",["-C",root,...args],{timeout:200,maxBuffer,stdio:["ignore","pipe","ignore"],env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});
 check(); return result;
}
export function identifyExternalGit(directory: string, workspace: string, check: () => void): ExternalGitScope | null {
 try {
  const output=git(directory,["rev-parse","--show-toplevel","HEAD"],check).toString("utf8").trim().split("\n");
  const root=realpathSync(output[0]!), head=output[1]!;
  const rel=relative(root,workspace);
  if ((!isAbsolute(rel) && rel!==".." && !rel.startsWith(`..${sep}`)) || !/^[a-f0-9]{40,64}$/.test(head)) return null;
  return {root,head,identity:`${root}:${head}`};
 } catch { return null; }
}
/** Changed paths only, bounded to one repository; status never authorizes content reads. */
export function externalChangedPaths(source: ExternalGitScope, check: () => void, scopes: readonly string[]): string[] {
 if (!scopes.length) return [];
 const pathspecs = scopes.map(scope => {
  const path = relative(source.root, scope).split(sep).join("/");
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error("external_git_scope");
  return `:(literal)${path || "."}`;
 });
 const rows = git(source.root, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...pathspecs], check, 1024 * 1024).toString("utf8").split("\0");
 const paths = new Set<string>();
 for (let i = 0; i < rows.length; i++) {
  const row = rows[i]; if (!row) continue;
  paths.add(resolve(source.root, row.slice(3)));
  if (/[RC]/.test(row.slice(0, 2)) && rows[i + 1]) paths.add(resolve(source.root, rows[++i]!));
 }
 return [...paths].sort();
}
/** Only HEAD blobs below the admitted scope. Never read checkout extraction deletions or sibling content. */
export function readExternalHead(input: { git: ExternalGitScope; scope: string; grant: PolicyRoot; roots: PolicyRootTable; maxFiles: number; maxBytes: number; check(): void; include?: readonly string[]; existing?: ReadonlyMap<string, Buffer>; paths?: readonly string[] }): Map<string,Buffer> {
 const result=new Map<string,Buffer>();
 const scopeRelative=relative(input.git.root,input.scope).split(sep).join("/");
 if (scopeRelative===".." || scopeRelative.startsWith("../") || isAbsolute(scopeRelative)) throw new Error("external_git_scope");
 if (input.paths?.length === 0) return result;
 const pathspecs = input.paths ? input.paths.map(path => `:(literal)${relative(input.git.root, path).split(sep).join("/")}`) : [`:(literal)${scopeRelative || "."}`];
 const listing=git(input.git.root,["ls-tree","-r","-z",input.git.head,"--",...pathspecs],input.check,64*1024).toString("utf8").split("\0");
 let bytes=0;
 for (const row of listing) {
  if (!row) continue;
  input.check();
  const match=/^(\d+) blob ([a-f0-9]{40,64})\t(.+)$/.exec(row);
  if (!match) throw new Error("external_git_entry");
  const path=resolve(input.git.root,match[3]!);
  const rel=relative(input.scope,path);
  if (isAbsolute(rel) || rel===".." || rel.startsWith(`..${sep}`) || (input.grant.kind==="file" && path!==input.scope)) continue;
  if (relative(input.git.root,path).split(sep).some(part=>forbidden.test(part))) continue;
  if (match[1]!=="100644" && match[1]!=="100755") throw new Error("external_git_symlink");
  if (existsSync(path)) authorizePolicyPath(input.roots,path);
  else {
   let parent=dirname(path);
   while (!existsSync(parent) && dirname(parent)!==parent) parent=dirname(parent);
   // Deleted descendants remain provable only within the canonical grant; no symlink ancestor escapes.
   if (realpathSync(parent)!==parent || !lstatSync(parent).isDirectory()) throw new Error("external_git_escape");
   const grantRel=relative(input.grant.canonicalPath,path);
   if (input.grant.kind==="directory" && (isAbsolute(grantRel)||grantRel===".."||grantRel.startsWith(`..${sep}`))) throw new Error("external_git_escape");
  }
  const lexical=resolve(input.grant.lexicalPath,relative(input.grant.canonicalPath,path));
  const logical=relative(input.roots.workspace,lexical).split(sep).join("/");
  if ((input.include && !checkScope([logical],input.include).inScope.length) || input.existing?.has(logical)) continue;
  if (result.size>=input.maxFiles) throw new Error("external_capture_limit");
  const content=git(input.git.root,["cat-file","blob",match[2]!],input.check,PROACTIVE_LIMITS.maxFileBytes+1);
  if (content.length>PROACTIVE_LIMITS.maxFileBytes || bytes+content.length>input.maxBytes || content.includes(0)) throw new Error("external_capture_limit");
  new TextDecoder("utf-8",{fatal:true}).decode(content);
  result.set(logical,content); bytes+=content.length;
 }
 if (identifyExternalGit(input.scope===input.grant.canonicalPath && input.grant.kind==="file" ? dirname(input.scope) : input.git.root,input.roots.workspace,input.check)?.identity!==input.git.identity) throw new Error("external_head_changed");
 return result;
}
