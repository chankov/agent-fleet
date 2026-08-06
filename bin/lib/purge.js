// purge.js — explicit human-config boundary for state-owned uninstall.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const HUMAN_CONFIG = [".ai/agent-fleet.json", ".ai/agent-fleet-overrides.md", ".ai/stt.json"];
export function purgeHumanConfig(workspace, { purgeConfig = false } = {}) {
  if (!purgeConfig) return { removed: [], preserved: HUMAN_CONFIG.filter((path) => existsSync(join(workspace, path))) };
  const removed = [];
  for (const path of HUMAN_CONFIG) if (existsSync(join(workspace, path))) { rmSync(join(workspace, path), { force: true }); removed.push(path); }
  return { removed, preserved: [] };
}
