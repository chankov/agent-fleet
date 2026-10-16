/** Emission-local original evidence. Pi 1.1.0 passes the same event to each result hook,
 * but loads each extension with its own module instance, so the capture is process-shared. */
interface EvidenceState {originals:WeakMap<object,unknown>;unavailable:WeakSet<object>;}
const storeKey=Symbol.for('agent-fleet.damage-result-evidence.v1');
const runtime=globalThis as typeof globalThis & {[key:symbol]:EvidenceState|undefined};
const {originals,unavailable}=runtime[storeKey]??= {originals:new WeakMap(),unavailable:new WeakSet()};
function freeze(value:any,seen=new Set<object>()){
 if(!value||typeof value!=='object'||seen.has(value))return;
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('unsupported_evidence');
 seen.add(value);for(const child of Object.values(value))freeze(child,seen);Object.freeze(value);
}
export type DamageCaptureState='uncaptured'|'captured'|'failed';
/** Consumers requiring independent provenance must require the captured state. */
export function damageCaptureState(event:object):DamageCaptureState{
 return unavailable.has(event)?'failed':originals.has(event)?'captured':'uncaptured';
}
/** Legacy parent compatibility: uncaptured is not a known capture failure. */
export function damageCaptureAvailable(event:object){return damageCaptureState(event)!=='failed';}
export function captureDamageResult<T extends {content:readonly unknown[]}>(event:T):T {
 if(!originals.has(event)&&!unavailable.has(event)){
  try{JSON.stringify(event);const snapshot=structuredClone(event);freeze(snapshot);originals.set(event,snapshot);}catch{unavailable.add(event);}
 }
 return (originals.get(event) as T|undefined)??event;
}
/** Failed capture is an explicit gap, never a mutable alias advertised as original. */
export function originalDamageResult<T extends object>(event:T):T|undefined{return unavailable.has(event)?undefined:(originals.get(event) as T|undefined)??event;}
