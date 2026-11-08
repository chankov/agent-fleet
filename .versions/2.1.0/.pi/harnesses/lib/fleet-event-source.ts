import {createHash} from 'node:crypto';
export type FleetEventOwner={project:string;peer:string;sessionId:string;startedAt:string};
export type FleetSourceEvent={kind:'message'|'question'|'permission';owner:FleetEventOwner;sourceId:string;toolCallId?:string;createdAt:number;deadline:number|null;contentDigest:string};
type Sink=(event:FleetSourceEvent)=>unknown;
const symbol=Symbol.for('fleet.addressed-event-sinks.v1');
const sinks:Map<string,Set<Sink>>=(globalThis as any)[symbol]??((globalThis as any)[symbol]=new Map());
const key=(owner:FleetEventOwner)=>JSON.stringify([owner.project,owner.peer,owner.sessionId,owner.startedAt]);
export const fleetSourceDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** In-process opt-in ingress only. No consumer means unchanged source behavior.
 * An active consumer MUST durably accept before the producer acknowledges admission.
 * Multiple consumers fail closed rather than broadcasting to several Codex chats. */
export function publishFleetSourceEvent(event:FleetSourceEvent){
 const listeners=sinks.get(key(event.owner));if(!listeners?.size)return {status:'disabled' as const};
 if(listeners.size!==1)throw Error('fleet_event_ingress_ambiguous');
 let ack:any;try{ack=[...listeners][0](structuredClone(event));if(ack?.status==='disabled'&&listeners.values().next().done===true)return {status:'disabled' as const};if(!ack||typeof ack.then==='function'||!['ingested','already_ingested','historical'].includes(ack.status)||typeof ack.eventId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(ack.eventId))throw Error('invalid_ingress_ack');}catch{throw Error('fleet_event_ingress_unavailable');}
 return {status:'durably_ingested' as const,eventId:ack.eventId as string};
}
export function subscribeFleetSourceEvents(owner:FleetEventOwner,sink:Sink){
 const id=key(owner),listeners=sinks.get(id)??new Set<Sink>();if(listeners.size)throw Error('fleet_event_consumer_already_registered');
 listeners.add(sink);sinks.set(id,listeners);return ()=>{listeners.delete(sink);if(!listeners.size)sinks.delete(id);};
}
