import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getPackageDir } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
export type CompactionPreflight = "eligible" | "no-history" | "unavailable";
/** Exact Pi preparation, not usage % or a string match on provider errors.
 * prepareCompaction is internal in verified Pi 1.1.0, so load its package-owned
 * module by absolute URL rather than assuming it is a public root export.
 */
export async function compactionPreflight(ctx: ExtensionContext): Promise<CompactionPreflight> {
 try {
  // Pi's loader can inject the SDK into an installed extension even when the
  // extracted package has no node_modules resolution path. Ask that SDK for
  // its owning package rather than resolving from the extension directory.
  const moduleUrl=pathToFileURL(join(getPackageDir(),"dist/core/compaction/compaction.js"));
  const { prepareCompaction } = await import(moduleUrl.href);
  if (typeof prepareCompaction !== "function") return "unavailable";
  const settings = SettingsManager.create(ctx.cwd).getCompactionSettings(ctx.model);
  return prepareCompaction(ctx.sessionManager.getBranch(), settings) ? "eligible" : "no-history";
 } catch { return "unavailable"; }
}
