// Reviewed project-content writes are separate from read grants and installer ownership.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertSafeWorkspaceTarget, assertWorkspaceRootSafe } from "./workspace-safety.js";

export function validateContentDestination(workspace, destination) {
  if (!destination || typeof destination.root !== "string" || !destination.root ||
      typeof destination.acceptedDecision !== "string" || !destination.acceptedDecision.trim() ||
      !Array.isArray(destination.evidence) || !destination.evidence.length ||
      !destination.evidence.every(value => typeof value === "string" && value.trim()) ||
      Object.keys(destination).some(key => !["root", "acceptedDecision", "evidence"].includes(key)))
    throw new Error("external content destination requires reviewed root, acceptedDecision and evidence");
  const root = resolve(workspace, destination.root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error("external content destination must be an existing real directory");
  assertWorkspaceRootSafe(root);
  const checkout = realpathSync(workspace);
  for (const [base, target] of [[root, checkout], [checkout, root]]) {
    const rel = relative(base, target);
    if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
      throw new Error("external content destination must be separate from the checkout");
  }
  return { root, acceptedDecision: destination.acceptedDecision, evidence: [...destination.evidence] };
}
export function externalContentTarget(workspace, destination, path) {
  const reviewed = validateContentDestination(workspace, destination);
  if (typeof path !== "string" || !/^\.ai\/(?:rules|commands|agent-prompts)\/.+/.test(path) ||
      path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") ||
      path.split("/").slice(2).some(part => /^(?:\..*|secrets?(?:\..*)?|credentials?(?:\..*)?|node_modules|vendor|dist|build|coverage|.*\.(?:pem|key|p12|pfx))$/i.test(part)))
    throw new Error(`invalid external project AI path: ${path}`);
  const target = assertSafeWorkspaceTarget(reviewed.root, path, { allowLeafSymlink: false });
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error("external project content target is not a regular file");
  return target;
}
