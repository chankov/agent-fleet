// purge.js — explicit human-config boundary for state-owned uninstall.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertSafeWorkspaceTarget } from "./workspace-safety.js";

const HUMAN_CONFIG = [".ai/agent-fleet.json", ".ai/agent-fleet-overrides.md", ".ai/stt.json"];
export function purgeHumanConfig(workspace, { purgeConfig = false, dryRun = false } = {}) {
  const present = HUMAN_CONFIG.filter((path) => {
    const target = assertSafeWorkspaceTarget(workspace, path, { allowLeafSymlink: false });
    return existsSync(target);
  });
  if (!purgeConfig) return { removed: [], preserved: present };
  if (dryRun) return { removed: [], wouldRemove: present, preserved: present };
  const removed = [];
  for (const path of present) { rmSync(join(workspace, path), { force: true }); removed.push(path); }
  return { removed, preserved: [] };
}
