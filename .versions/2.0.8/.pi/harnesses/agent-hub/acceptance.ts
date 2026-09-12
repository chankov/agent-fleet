import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveArtifactPath, artifactPreviewFromText } from "./artifacts.js";
import type { DispatchAgentParams } from "./tools/context.ts";

type Roots = { cwd: string; sessionDir: string };
export interface DeliverableContract {
 files: { input: string; path: string; before: string | null }[];
 scopeRoots: { scope: string; root: string; exists: boolean }[];
}
export interface DeliverableReadback {
 path: string; status: "read" | "missing" | "unreadable"; changed?: boolean;
 sha256?: string; bytes?: number; preview?: string; reason?: string; retainedPath?: string;
}
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
function checkedPath(path: string, roots: Roots): string {
 const allowed = [resolve(roots.cwd), resolve(roots.sessionDir)];
 if (!allowed.some(root => within(root, path))) throw new Error(`Path outside repository/session: ${path}`);
 let ancestor = path;
 while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
 const real = realpathSync(ancestor);
 if (!allowed.some(root => existsSync(root) && within(realpathSync(root), real))) throw new Error(`Symlink path outside repository/session: ${path}`);
 return path;
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const exactArtifactPath = (input: string, roots: Roots) => checkedPath(resolveArtifactPath(input, {
 repoDir: roots.cwd, sessionDir: roots.sessionDir, exists: () => true, // No guessing another artifact kind.
}).path, roots);

export function preflightDeliverables(params: Pick<DispatchAgentParams, "scope" | "scope_mode" | "deliverables">, roots: Roots): DeliverableContract {
 const files = (params.deliverables ?? []).map(input => {
  const path = exactArtifactPath(input, roots);
  let before: string | null = null;
  try { if (statSync(path).isFile()) before = digest(readFileSync(path)); } catch {}
  return { input, path, before };
 });
 const scopeRoots = (params.scope ?? []).map(scope => {
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  const wildcard = normalized.search(/[*?]/);
  const prefix = wildcard < 0 ? normalized.replace(/\/+$/, "") : normalized.slice(0, wildcard);
  const base = wildcard < 0 ? prefix : prefix.slice(0, prefix.lastIndexOf("/") + 1);
  const root = checkedPath(resolve(roots.cwd, base || "."), roots), exists = existsSync(root);
  const declaredNewFile = wildcard < 0 && !normalized.endsWith("/") && files.some(file => file.path === root) && existsSync(dirname(root)) && statSync(dirname(root)).isDirectory();
  if (!exists && params.scope_mode !== "create" && !declaredNewFile) throw new Error(`Missing scope root: ${scope} (resolved to ${root}). Correct the path or explicitly declare scope_mode: create for new work. This is not a zero-match result.`);
  if (exists && wildcard >= 0 && !statSync(root).isDirectory()) throw new Error(`Scope root is not a directory: ${root}`);
  return { scope, root, exists };
 });
 return { files, scopeRoots };
}

export function readBackDeliverables(contract: DeliverableContract, roots: Roots, retain?: (index: number, bytes: Buffer) => string): DeliverableReadback[] {
 return contract.files.map((file, index) => {
  try {
   checkedPath(file.path, roots);
   if (!existsSync(file.path)) return { path: file.path, status: "missing" };
   if (!statSync(file.path).isFile()) return { path: file.path, status: "unreadable", reason: "not a regular file" };
   const bytes = readFileSync(file.path), sha256 = digest(bytes);
   return { path: file.path, status: "read", sha256, bytes: bytes.length, changed: file.before !== sha256, preview: artifactPreviewFromText(bytes.toString("utf8")), ...(retain ? { retainedPath: retain(index, bytes) } : {}) };
  } catch (error) { return { path: file.path, status: "unreadable", reason: String(error) }; }
 });
}
