import {createHash} from 'node:crypto';
import {redactSecrets} from './fleet-transcript-store.ts';

/** Display text is never an identity or executable action. Redact before clipping. */
export function damagePreview(text:string,limit=500):string {
 const safe=redactSecrets(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'');
 return safe.length>limit ? safe.slice(0,limit)+'… [truncated]' : safe;
}

/** Audit retains correlation metadata, never raw tool input or a command preview. */
export function damageInputAudit(input:unknown) {
 const serialized=JSON.stringify(input)??'undefined';
 return {schema:'damage-input-audit/v1',sha256:createHash('sha256').update(serialized).digest('hex'),bytes:Buffer.byteLength(serialized)};
}
