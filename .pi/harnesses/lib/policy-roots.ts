import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type PolicyRole = "workspace" | "rules" | "docs";
export interface PolicyRoot {
 readonly id: string;
 readonly role: PolicyRole;
 readonly configuredPath: string;
 readonly lexicalPath: string;
 readonly canonicalPath: string;
 readonly kind: "directory" | "file";
}
export interface PolicyRootDiagnostic {
 readonly code: string;
 readonly path: string;
 readonly message: string;
}
export interface PolicyRootTable {
 readonly workspace: string;
 readonly roots: readonly PolicyRoot[];
 readonly diagnostics: readonly PolicyRootDiagnostic[];
}
export interface AuthorizedPolicyPath {
 readonly root: PolicyRoot;
 readonly path: string;
}

// Shared policy-source exclusions, not a replacement for consumer-specific permissions.
const deniedSegment = /^(?:\.git|\.pi|node_modules|vendor|dist|build|coverage|\.env(?:\..*)?|credentials?|secrets?)$/i;
const denied = (path: string) => path.split(/[\\/]/).some(part => deniedSegment.test(part));
function inside(root: string, target: string): boolean {
 const rel = relative(root, target);
 return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function covers(root: PolicyRoot, target: string, base = root.canonicalPath): boolean {
 return root.kind === "file" ? target === base : inside(base, target);
}
function currentRoot(root: PolicyRoot): void {
 let canonical: string;
 try { canonical = realpathSync(root.lexicalPath); }
 catch { throw new Error(`root_changed:${root.configuredPath}`); }
 if (canonical !== root.canonicalPath) throw new Error(`root_changed:${root.configuredPath}`);
 const stat = statSync(root.lexicalPath);
 if (root.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`root_changed:${root.configuredPath}`);
}

/** Resolve only explicit grants, relative to the checkout, never a child's cwd.
 * This table conveys read authorization only: no registration, capture consent or write ownership.
 * Consumers must reauthorize each access and retain their own narrower limits.
 */
export function resolvePolicyRoots(checkout: string, config: { rulesDirs?: readonly string[]; docsPaths?: readonly string[] }): PolicyRootTable {
 const workspace = realpathSync(checkout);
 const roots: PolicyRoot[] = [Object.freeze({ id: "workspace", role: "workspace", configuredPath: ".", lexicalPath: resolve(checkout), canonicalPath: workspace, kind: "directory" })];
 const diagnostics: PolicyRootDiagnostic[] = [];
 const note = (code: string, path: string) => diagnostics.push(Object.freeze({ code, path, message: `${code}:${path}` }));
 for (const [role, paths] of [["rules", config.rulesDirs ?? []], ["docs", config.docsPaths ?? []]] as const) {
  for (const configuredPath of paths) {
   if (!configuredPath || isAbsolute(configuredPath) || configuredPath.includes("\\")) { note("invalid_root", configuredPath); continue; }
   const lexicalPath = resolve(checkout, configuredPath);
   if (denied(configuredPath)) { note("denied_path", configuredPath); continue; }
   let canonicalPath: string;
   try { canonicalPath = realpathSync(lexicalPath); }
   catch { note("missing_root", configuredPath); continue; }
   if (denied(canonicalPath)) { note("denied_path", configuredPath); continue; }
   // Do not turn the checkout's parent (or another ancestor) into an inventory grant.
   if (canonicalPath !== workspace && inside(canonicalPath, workspace)) { note("unsafe_root", configuredPath); continue; }
   const stat = statSync(canonicalPath);
   if ((!stat.isDirectory() && !stat.isFile()) || (role === "rules" && !stat.isDirectory())) { note("invalid_root_type", configuredPath); continue; }
   if (roots.some(root => root.role === role && root.canonicalPath === canonicalPath)) { note("duplicate_root", configuredPath); continue; }
   const root: PolicyRoot = Object.freeze({ id: `${role}:${canonicalPath}`, role, configuredPath, lexicalPath, canonicalPath, kind: stat.isDirectory() ? "directory" : "file" });
   for (const existing of roots.filter(r => r.role !== "workspace")) {
    if (covers(existing, canonicalPath) || covers(root, existing.canonicalPath)) note("overlapping_roots", configuredPath);
   }
   roots.push(root);
  }
 }
 return Object.freeze({ workspace, roots: Object.freeze(roots), diagnostics: Object.freeze(diagnostics) });
}

/** Revalidate the grant and both lexical/canonical containment before every read.
 * Exact files never authorize parent inventory. Missing paths remain explicit errors.
 */
export function authorizePolicyPath(table: PolicyRootTable, path: string, operation: "read" | "inventory" = "read"): AuthorizedPolicyPath {
 const target = resolve(table.workspace, path);
 if (denied(path)) throw new Error(`denied_path:${path}`);
 // Prefer the explicit lexical grant so a changed root cannot fall back to the workspace.
 const candidates = table.roots.filter(root => covers(root, target, root.lexicalPath) || covers(root, target));
 candidates.sort((a, b) => (a.role === "workspace" ? 1 : 0) - (b.role === "workspace" ? 1 : 0) || b.canonicalPath.length - a.canonicalPath.length || a.id.localeCompare(b.id));
 const root = candidates[0];
 if (!root) throw new Error(`ungranted_path:${path}`);
 currentRoot(root);
 let canonical: string;
 try { canonical = realpathSync(target); }
 catch { throw new Error(`missing_path:${path}`); }
 if (!covers(root, canonical)) throw new Error(`canonical_escape:${path}`);
 if (denied(canonical)) throw new Error(`denied_path:${path}`);
 if (operation === "inventory" && (root.kind !== "directory" || !statSync(canonical).isDirectory())) throw new Error(`inventory_requires_directory:${path}`);
 return { root, path: canonical };
}

/** Bind child references before spawn. Local identities stay unchanged; external refs never depend on child cwd. */
export function resolvePolicyReferences(table: PolicyRootTable, paths: readonly string[], role: "rules" | "docs"): string[] {
 return paths.map(path=>{
  const target=resolve(table.workspace,path);
  if (inside(table.workspace,target)) return path;
  const source=authorizePolicyPath(table,path);
  if (source.root.role!==role) throw new Error(`ungranted_reference:${path}`);
  return source.path;
 });
}

/** Explicit external capture scope authorization; parsing still owns syntax and capture owns evidence/limits. */
export function policyRootValidationContext(table: PolicyRootTable) {
 return { externalIncludeAllowed: (include: string): boolean => {
  const subtree = include.endsWith("/**");
  const path = subtree ? include.slice(0,-3) : include;
  try {
   const source = authorizePolicyPath(table,path,subtree ? "inventory" : "read");
   return source.root.role !== "workspace";
  } catch { return false; }
 } };
}

/** Legacy identities stay logical. A relocation neither selects an ambiguous source nor repins its hash. */
export function resolveRuleBinding(table: PolicyRootTable, logicalPath: string): AuthorizedPolicyPath {
 if (!logicalPath.startsWith(".ai/rules/") || logicalPath.includes("\\") || logicalPath.split("/").some(part => !part || part === "." || part === "..") || denied(logicalPath)) throw new Error(`invalid_binding:${logicalPath}`);
 const suffix = logicalPath.slice(".ai/rules/".length);
 const candidates: AuthorizedPolicyPath[] = [];
 const paths = [resolve(table.workspace, logicalPath), ...table.roots.filter(root => root.role === "rules").map(root => resolve(root.lexicalPath, suffix))];
 for (const path of paths) {
  let candidate: AuthorizedPolicyPath;
  try { candidate = authorizePolicyPath(table, path); }
  catch (error) {
   if (error instanceof Error && error.message.startsWith("missing_path:")) continue;
   throw error;
  }
  if (!statSync(candidate.path).isFile()) throw new Error(`invalid_binding_type:${logicalPath}`);
  if (!candidates.some(item => item.path === candidate.path)) candidates.push(candidate);
 }
 if (candidates.length !== 1) throw new Error(`${candidates.length ? "ambiguous_binding" : "missing_binding"}:${logicalPath}`);
 return candidates[0]!;
}
