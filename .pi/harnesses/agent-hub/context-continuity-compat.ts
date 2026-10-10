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
export function contextContinuityCompatibility(version: string): ContextContinuityCompatibility {
  return {
    supported: version === "1.1.0",
    version,
    reason: version === "1.1.0"
      ? "verified real CLI settled/compact/continuation contract"
      : "unsupported settled continuation contract; preserve native baseline",
  };
}
