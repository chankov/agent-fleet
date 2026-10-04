import { loadSystem1Snapshot } from "../lib/system1/config-loader.js";
import type { ProactiveConfig } from "./proactive-types.ts";
import { type ReviewedLocalBinding } from "./proactive-local.ts";
export type LocalProactiveConfig = ProactiveConfig & { readonly localBindings?: readonly ReviewedLocalBinding[] };

import { parseProactiveConfig as parseShared } from "../lib/system1/config-proactive.js";
export { PROACTIVE_LIMITS } from "../lib/system1/config-proactive.js";
const OFF = parseShared({ version: 1, mode: "off" }) as LocalProactiveConfig;
export function parseProactiveConfig(value: unknown): LocalProactiveConfig { return parseShared(value) as LocalProactiveConfig; }
/** Missing or invalid section cannot authorize capture; shared snapshot is optional for standalone callers. */
export function loadProactiveConfig(repo: string, snapshot = loadSystem1Snapshot(repo)): LocalProactiveConfig {
 const section = snapshot.consumers.proactiveReview;
 if (section.status === "invalid") throw new Error("Invalid $.consumers.proactiveReview");
 return section.config as LocalProactiveConfig ?? OFF;
}
export function isCaptureEnabled(config: ProactiveConfig): boolean { return config.mode === "shadow" || config.mode === "advisory"; }
