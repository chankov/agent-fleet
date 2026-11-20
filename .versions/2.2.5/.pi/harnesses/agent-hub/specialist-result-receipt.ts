import type { SpecialistResult } from "./specialist-result.ts";

/** Transport receipt, not task acceptance. Requires a matched successful call. */
export function resultFromToolEvent(enabled:boolean|undefined,input:unknown,tool:string,result:any,isError:unknown):SpecialistResult|null {
 if(!enabled||tool!=="submit_result"||isError!==false||!input)return null;
 const received=result?.details?.specialistResult;
 if(!received||!["completed","partial","blocked"].includes(received.status)||!Array.isArray(received.evidence))return null;
 if(received.evidence.some((r:any)=>!r||typeof r.path!=="string"))return null;
 const plain={...received,evidence:received.evidence.map((r:any)=>({path:r.path}))};
 if(JSON.stringify(plain)!==JSON.stringify(input))return null;
 if(received.evidence.some((r:any)=>typeof r.sha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<0))return null;
 return received;
}
