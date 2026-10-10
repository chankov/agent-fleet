export interface ManagedCompactionRequest { instructions: string; nextStep?: string }
export interface ManagedCompactionController { request(request: ManagedCompactionRequest): void }
const key=Symbol.for("agent-fleet.context-continuity.controllers/v1");
const shared=globalThis as typeof globalThis & {[key]?: WeakMap<object,ManagedCompactionController>};
const controllers=shared[key] ??= new WeakMap<object,ManagedCompactionController>();
export function registerManagedCompaction(session: object,controller: ManagedCompactionController): void {controllers.set(session,controller);}
export function managedCompaction(session: object): ManagedCompactionController | undefined {return controllers.get(session);}
