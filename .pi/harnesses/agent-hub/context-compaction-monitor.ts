import { COMPACTION_MIN_PERCENT, COMPACTION_EARLY_PERCENT, COMPACTION_TARGET_PERCENT, COMPACTION_MAX_PERCENT } from "../lib/context-compaction-policy.js";

export type CompactionMonitorPhase = "started" | "restored" | "continuation_requested" | "continued" | "failed" | "ceiling_blocked";
interface Usage { tokens?: number | null; contextWindow?: number | null }
/** Metadata-only local evidence. Unknown post-summary usage stays unknown until
 * the next provider measurement; never report a fabricated reduction. */
export function createCompactionMonitor(emit: (event: Record<string, unknown>) => void) {
 let before: number | null = null, after: number | null = null;
 let episode = 0, startedAt = 0, phase: CompactionMonitorPhase | "idle" = "idle";
 let awaitingMeasurement = false;
 const percent = (usage?: Usage) => typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) &&
  typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
  ? usage.tokens / usage.contextWindow * 100 : null;
 const snapshot = () => ({ version: 1, episode, phase, beforePercent: before, afterPercent: after,
  minimumPercent: COMPACTION_MIN_PERCENT, earlyPercent: COMPACTION_EARLY_PERCENT,
  targetPercent: COMPACTION_TARGET_PERCENT, maximumPercent: COMPACTION_MAX_PERCENT });
 return {
  snapshot,
  reset() {before=null;after=null;episode=0;startedAt=0;phase="idle";awaitingMeasurement=false;},
  record(next: CompactionMonitorPhase, usage?: Usage) {
   if(next === "started") { episode++; before=percent(usage); after=null; startedAt=Date.now(); awaitingMeasurement=false; }
   if(next === "restored") { after=percent(usage); awaitingMeasurement=after===null; }
   phase=next;
   emit({...snapshot(),elapsedMs:startedAt?Math.max(0,Date.now()-startedAt):null,
    ceilingExceeded: (percent(usage) ?? 0) > COMPACTION_MAX_PERCENT});
  },
  observe(usage?: Usage) {
   if(!awaitingMeasurement)return;
   const measured=percent(usage);if(measured===null)return;
   after=measured;awaitingMeasurement=false;
   if(phase==="continuation_requested")phase="continued";
   emit({...snapshot(),measurement:"first_post_compaction",ceilingExceeded:measured>COMPACTION_MAX_PERCENT});
  },
 };
}
