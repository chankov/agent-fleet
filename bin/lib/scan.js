// Deterministic, bounded project facts used for generated overrides.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const RULE_DIRS = [".cursor/rules", ".github/rules", "rules", ".agent/rules"];
const DOC_PATHS = ["docs", "DOCS.md", "README.md"];

function existingDirectories(workspace, candidates) {
  return candidates.filter((path) => {
    try { return existsSync(join(workspace, path)) && statSync(join(workspace, path)).isDirectory(); }
    catch { return false; }
  }).sort();
}
function existingPaths(workspace, candidates) {
  return candidates.filter((path) => existsSync(join(workspace, path))).sort();
}

/** Scan only declared conventional paths; never recursively crawls a project. */
export function scanProject(workspace) {
  return {
    rules: existingDirectories(workspace, RULE_DIRS),
    docs: existingPaths(workspace, DOC_PATHS),
  };
}
