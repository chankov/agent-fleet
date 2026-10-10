export const CONTEXT_COMPACTION_LIMITS = Object.freeze({timeoutMs:1000,maxStateBytes:8192});
/** Independent opt-in. Invalid semantic policy cannot disable deterministic recovery. */
/** @param {unknown} input */
export function parseContextCompactionConfig(input) {
 const value=/** @type {Record<string,any>} */ (input);
 if(!value || typeof value!== 'object' || Array.isArray(value)) throw Error('Invalid contextCompaction section');
 if(Object.keys(value).some(k=>!['mode','remoteContextApproved','earlyOpportunityPercent','limits'].includes(k)) || !['off','automatic'].includes(value.mode) || (value.remoteContextApproved!==undefined && typeof value.remoteContextApproved!=='boolean')) throw Error('Invalid contextCompaction section');
 const percent=value.earlyOpportunityPercent ?? 60;
 if(typeof percent!== 'number' || !Number.isFinite(percent) || percent<=0 || percent>=80) throw Error('Invalid early opportunity threshold');
 const supplied=value.limits ?? {};
 if(!supplied || typeof supplied!== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(k=>!Object.hasOwn(CONTEXT_COMPACTION_LIMITS,k))) throw Error('Invalid contextCompaction limits');
 const limits={...CONTEXT_COMPACTION_LIMITS,...supplied};
 if(Object.entries(limits).some(([k,v])=>!Number.isSafeInteger(v) || v<=0 || v>CONTEXT_COMPACTION_LIMITS[/** @type {keyof typeof CONTEXT_COMPACTION_LIMITS} */ (k)]))throw Error('Invalid contextCompaction limits');
 return {mode:value.mode,remoteContextApproved:value.remoteContextApproved===true,earlyOpportunityPercent:percent,limits};
}
