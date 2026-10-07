// Typed facade over the runtime shared with the JavaScript-only CLI.
import * as runtime from "./policy-roots.js";

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
export const resolvePolicyRoots = runtime.resolvePolicyRoots as (checkout: string, config: { rulesDirs?: readonly string[]; docsPaths?: readonly string[] }) => PolicyRootTable;
export const authorizePolicyPath = runtime.authorizePolicyPath as (table: PolicyRootTable, path: string, operation?: "read" | "inventory") => AuthorizedPolicyPath;
export const resolvePolicyReferences = runtime.resolvePolicyReferences as (table: PolicyRootTable, paths: readonly string[], role: "rules" | "docs") => string[];
export const policyRootValidationContext = runtime.policyRootValidationContext as (table: PolicyRootTable) => { externalIncludeAllowed(include: string): boolean };
export const resolveRuleBinding = runtime.resolveRuleBinding as (table: PolicyRootTable, logicalPath: string) => AuthorizedPolicyPath;
