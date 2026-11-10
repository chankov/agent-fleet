import { processShared } from "../lib/process-shared.ts";
export interface ManagedCompactionRequest { instructions: string; nextStep?: string }
export interface ManagedCompactionController { request(request: ManagedCompactionRequest): void }
/** Read without an import by compact-and-continue, which must load without the Hub. */
export const MANAGED_COMPACTION_KEY="agent-fleet.context-continuity.controllers/v1";
const controllers=processShared(MANAGED_COMPACTION_KEY,()=>new WeakMap<object,ManagedCompactionController>());
export function registerManagedCompaction(session: object,controller: ManagedCompactionController): void {controllers.set(session,controller);}
export function managedCompaction(session: object): ManagedCompactionController | undefined {return controllers.get(session);}
