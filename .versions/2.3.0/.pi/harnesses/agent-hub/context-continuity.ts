/** Runtime-owned recovery. Advice never changes identity, gates or budgets. */
export type ContinuityPhase = "idle" | "pending" | "compacting" | "restoring" | "recovered" | "skipped" | "failed" | "fenced";
export interface ContinuityIdentity { session: string; task: string; revision: number; owner: string; attempt: number }
export interface ContinuityCapsule {
  identity: ContinuityIdentity;
  episode: number;
  nextStep: string;
  ledgerRefs: string[];
  pendingOperations: string[];
}
export interface ContinuityEligibility { active: boolean; cancelled: boolean; completed: boolean; waitingUser: boolean; budgetBlocked: boolean }
export interface ContinuityPorts {
  identity(): ContinuityIdentity;
  eligibility(): ContinuityEligibility;
  compact(instructions: string): Promise<void>;
  restore(capsule: ContinuityCapsule): Promise<boolean>;
  replayUser(): boolean;
  continueTask(capsule: ContinuityCapsule): void;
}
const same = (a: ContinuityIdentity,b: ContinuityIdentity) => a.session===b.session && a.task===b.task && a.revision===b.revision && a.owner===b.owner && a.attempt===b.attempt;
const permitted = (e: ContinuityEligibility) => e.active && !e.cancelled && !e.completed && !e.waitingUser && !e.budgetBlocked;
export class ContextContinuityCoordinator {
  phase: ContinuityPhase = "idle";
  episode = 0;
  capsule: ContinuityCapsule | null = null;
  private generation = 0;
  private running: Promise<boolean> | null = null;
  private continued = new Set<number>();
  private restored = new Set<number>();
  private ports: ContinuityPorts;
  constructor(ports: ContinuityPorts) { this.ports=ports; }
  request(nextStep: string, ledgerRefs: string[] = [], pendingOperations: string[] = []): ContinuityCapsule {
    if (this.capsule && ["pending","compacting","restoring"].includes(this.phase) && same(this.capsule.identity,this.ports.identity())) return this.capsule;
    this.capsule = {identity:{...this.ports.identity()},episode:++this.episode,nextStep,ledgerRefs:[...ledgerRefs],pendingOperations:[...pendingOperations]};
    this.phase="pending"; return this.capsule;
  }
  fence(): void { this.generation++; this.phase="fenced"; this.capsule=null; }
  private current(c: ContinuityCapsule,g: number): boolean { return g===this.generation && this.capsule===c && same(c.identity,this.ports.identity()); }
  private async recovered(c: ContinuityCapsule,g: number): Promise<boolean> {
    if (!this.current(c,g)) return false;
    if (this.restored.has(c.episode)) return this.phase==="recovered";
    if(this.phase==="restoring")return false;
    this.restored.add(c.episode); this.phase="restoring";
    let ok=false;
    try { ok=await this.ports.restore(c); } catch {}
    if (!this.current(c,g)) return false;
    if (!ok) { this.phase="failed"; return false; }
    this.phase="recovered";
    if (this.ports.replayUser()) return true;
    if (!permitted(this.ports.eligibility()) || this.continued.has(c.episode)) return true;
    this.continued.add(c.episode); this.ports.continueTask(c); return true;
  }
  /** Explicit request with no compactable history: no compact or restore success
   * is fabricated. The same identity/gates/user priority fence continuation.
   */
  skipNoHistory(): boolean {
    const c=this.capsule,g=this.generation;
    if(this.running || !c || this.phase!=="pending" || !this.current(c,g))return false;
    this.phase="skipped";
    if(this.ports.replayUser())return true;
    if(!permitted(this.ports.eligibility()) || this.continued.has(c.episode))return true;
    this.continued.add(c.episode);this.ports.continueTask(c);return true;
  }
  /** Await this in agent_settled; never defer synthetic continuation with a timer. */
  run(instructions: string): Promise<boolean> {
    if (this.running) return this.running;
    const c=this.capsule, g=this.generation;
    if (!c || this.phase!=="pending" || !this.current(c,g)) return Promise.resolve(false);
    this.phase="compacting";
    this.running=(async()=>{
      try { await this.ports.compact(instructions); return await this.recovered(c,g); }
      catch { if(this.current(c,g)) this.phase="failed"; return false; }
      finally { this.running=null; }
    })(); return this.running;
  }
  /** Native compaction shares the episode but cannot race the manual callback. */
  nativeCompacted(): Promise<boolean> {
    if (this.running) return Promise.resolve(true);
    if (!this.capsule || this.phase==="skipped" || this.phase==="fenced") return Promise.resolve(false);
    return this.recovered(this.capsule,this.generation);
  }
}
