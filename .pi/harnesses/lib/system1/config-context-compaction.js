import { COMPACTION_MIN_PERCENT, COMPACTION_EARLY_PERCENT, COMPACTION_TARGET_PERCENT } from "../context-compaction-policy.js";
export const CONTEXT_COMPACTION_LIMITS = Object.freeze({timeoutMs:1000,maxStateBytes:8192});
/** Independent opt-in. Invalid semantic policy cannot disable deterministic recovery. */
/** @param {unknown} input */
export function parseContextCompactionConfig(input) {
 const value=/** @type {Record<string,any>} */ (input);
 if(!value || typeof value!== 'object' || Array.isArray(value)) throw Error('Invalid contextCompaction section');
 if(Object.keys(value).some(k=>!['mode','remoteContextApproved','earlyOpportunityPercent','limits'].includes(k)) || !['off','automatic'].includes(value.mode) || (value.remoteContextApproved!==undefined && typeof value.remoteContextApproved!=='boolean')) throw Error('Invalid contextCompaction section');
 const percent=value.earlyOpportunityPercent ?? COMPACTION_EARLY_PERCENT;
 if(typeof percent!== 'number' || !Number.isFinite(percent) || percent<COMPACTION_MIN_PERCENT || percent>COMPACTION_TARGET_PERCENT) throw Error('Invalid early opportunity threshold');
 const supplied=value.limits ?? {};
 if(!supplied || typeof supplied!== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(k=>!Object.hasOwn(CONTEXT_COMPACTION_LIMITS,k))) throw Error('Invalid contextCompaction limits');
 const limits={...CONTEXT_COMPACTION_LIMITS,...supplied};
 if(Object.entries(limits).some(([k,v])=>!Number.isSafeInteger(v) || v<=0 || v>CONTEXT_COMPACTION_LIMITS[/** @type {keyof typeof CONTEXT_COMPACTION_LIMITS} */ (k)]))throw Error('Invalid contextCompaction limits');
 return {mode:value.mode,remoteContextApproved:value.remoteContextApproved===true,earlyOpportunityPercent:percent,limits};
}
