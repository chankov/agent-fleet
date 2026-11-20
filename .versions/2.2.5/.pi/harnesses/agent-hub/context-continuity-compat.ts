import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
/** D7 capability gate. A method called compact is not a lifecycle contract. */
export interface ContextContinuityCompatibility {
  supported: boolean;
  version: string;
  reason: string;
}
export function currentPiRuntimeVersion(entry = process.argv[1]): string {
  if(!entry) return "unknown";
  // npm's `pi` executable is a symlink outside the runtime package. Resolve
  // it before walking ancestors; unresolved launchers remain unsupported.
  let path: string;
  try { path=dirname(realpathSync(entry)); } catch { return "unknown"; }
  for(let depth=0;depth<5;depth++) {
    try { const pkg=JSON.parse(readFileSync(join(path,"package.json"),"utf8"));if(pkg.name==="@earendil-works/pi-coding-agent")return typeof pkg.version==="string"?pkg.version:"unknown"; } catch {}
    const parent=dirname(path);if(parent===path)break;path=parent;
  }
  return "unknown";
}
/** First Pi release with the settled/compact/continuation lifecycle D7 relies on. */
export const CONTEXT_CONTINUITY_MIN_PI_VERSION = "1.1.0";
/** Plain x.y.z releases only: unknown, pre-release and custom builds stay unsupported. */
function parseRelease(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function contextContinuityCompatibility(version: string): ContextContinuityCompatibility {
  const actual = parseRelease(version), minimum = parseRelease(CONTEXT_CONTINUITY_MIN_PI_VERSION)!;
  // Minimum-version gate (maintainer decision 2026-11-11): later Pi releases are
  // admitted without a new Agent Fleet package. Contract drift in a future Pi
  // surfaces as a recorded compaction/restore failure, not as a silent baseline.
  let supported = false;
  if (actual) {
    const index = actual.findIndex((part, i) => part !== minimum[i]);
    supported = index === -1 || actual[index] > minimum[index];
  }
  return {
    supported,
    version,
    reason: supported
      ? `Pi ${version} satisfies minimum ${CONTEXT_CONTINUITY_MIN_PI_VERSION} for the settled/compact/continuation contract`
      : `Pi ${version || "unknown"} is below minimum ${CONTEXT_CONTINUITY_MIN_PI_VERSION} or not a plain release; preserve native baseline`,
  };
}
