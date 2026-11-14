// S1: process-local cooperative-agent policy, NOT human authentication.
// Caller supplies context and fresh target snapshots. No discovery, I/O or persistence.
export type ConversationKey = Readonly<{ hostProfile: string; principal: string; threadId: string }>;
export type TargetEpoch = Readonly<{ project: string; peer: string; sessionId: string; startedAt: string }>;
export type Right = 'read' | 'send' | 'approve';
export type BindingHandle = Readonly<{ alias: string; generation: number }>;
export type BindingView = Readonly<{ alias: string; generation: number; target: TargetEpoch; rights: readonly Right[]; stale: boolean }>;
export type AllowlistCode = 'INVALID_CONTEXT' | 'INVALID_INPUT' | 'NOT_ALLOWED' | 'AMBIGUOUS_TARGET'
  | 'STALE_HANDLE' | 'STALE_TARGET' | 'TARGET_UNAVAILABLE' | 'APPROVE_NOT_GRANTED' | 'SEND_NOT_GRANTED' | 'UNSUPPORTED_RIGHT';

export class AllowlistError extends Error {
  readonly code: AllowlistCode;
  constructor(code: AllowlistCode) {
    super(code); // Never include other namespaces, targets or caller payload in errors.
    this.name = 'AllowlistError';
    this.code = code;
  }
}

type Binding = { alias: string; generation: number; target: TargetEpoch; send: boolean; approve: boolean; stale: boolean };
type Issued = { namespace: string; alias: string; generation: number };
const contextFields = ['hostProfile', 'principal', 'threadId'] as const;
const targetFields = ['project', 'peer', 'sessionId', 'startedAt'] as const;
function fail(code: AllowlistCode): never { throw new AllowlistError(code); }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024
  && v.trim() === v && !/[\u0000-\u001f\u007f*]/u.test(v);

function shaped(v: unknown, fields: readonly string[]): boolean {
  return record(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k) && text(v[k]));
}
function namespace(context: ConversationKey): string {
  if (!shaped(context, contextFields)) fail('INVALID_CONTEXT');
  return JSON.stringify(contextFields.map(k => context[k]));
}
function epoch(target: TargetEpoch): TargetEpoch {
  if (!shaped(target, targetFields)) fail('INVALID_INPUT');
  return { project: target.project, peer: target.peer, sessionId: target.sessionId, startedAt: target.startedAt };
}
const sameEpoch = (a: TargetEpoch, b: TargetEpoch): boolean => targetFields.every(k => a[k] === b[k]);

/** In-memory only. Handles are opaque, instance-local and intentionally non-serializable.
 * No identity or consent provenance is established by these inputs/handles.
 * All rights/target transitions invalidate old handles; lookup never creates a grant.
 */
export class AllowedSessionsPolicy {
  #spaces = new Map<string, Map<string, Binding>>();
  #issued = new WeakMap<object, Issued>();
  #generation = 0;

  #handle(key: string, binding: Binding): BindingHandle {
    const h = Object.freeze({ alias: binding.alias, generation: binding.generation });
    this.#issued.set(h, { namespace: key, alias: binding.alias, generation: binding.generation });
    return h;
  }

  #binding(context: ConversationKey, handle: BindingHandle): { key: string; binding: Binding } {
    const key = namespace(context);
    const issued = record(handle) ? this.#issued.get(handle) : undefined;
    if (!issued || issued.namespace !== key) fail('STALE_HANDLE');
    const binding = this.#spaces.get(key)?.get(issued.alias);
    if (!binding || binding.generation !== issued.generation) fail('STALE_HANDLE');
    return { key, binding };
  }

  #current(target: TargetEpoch, current: readonly TargetEpoch[]): void {
    if (!Array.isArray(current)) fail('INVALID_INPUT');
    // Validate supplied snapshots even when an invalid entry would otherwise be ignored.
    const snapshots = Array.from(current, v => epoch(v));
    const matches = snapshots.filter(v => v.project === target.project && v.peer === target.peer);
    if (!matches.length) fail('TARGET_UNAVAILABLE');
    if (matches.length !== 1) fail('AMBIGUOUS_TARGET');
    if (!sameEpoch(matches[0], target)) fail('STALE_TARGET');
  }

  #active(binding: Binding, current: readonly TargetEpoch[]): void {
    if (binding.stale) fail('STALE_TARGET');
    try { this.#current(binding.target, current); }
    catch (e) {
      // A positively observed epoch change cannot silently recover from an older snapshot.
      if (e instanceof AllowlistError && e.code === 'STALE_TARGET') binding.stale = true;
      throw e;
    }
  }

  /** Explicit reviewed policy input; always read-only. Send requires grantSend separately. */
  enroll(context: ConversationKey, proposal: Readonly<{ alias: string; target: TargetEpoch }>, current: readonly TargetEpoch[]): BindingHandle {
    const key = namespace(context);
    if (!record(proposal) || Object.keys(proposal).length !== 2 || !Object.hasOwn(proposal, 'alias')
        || !Object.hasOwn(proposal, 'target') || !text(proposal.alias)) fail('INVALID_INPUT');
    const target = epoch(proposal.target);
    this.#current(target, current);
    const space = this.#spaces.get(key) ?? new Map<string, Binding>();
    // No implicit replacement or duplicate alias for an already-enrolled exact target.
    if (space.has(proposal.alias) || [...space.values()].some(b => sameEpoch(b.target, target))) fail('INVALID_INPUT');
    const binding: Binding = { alias: proposal.alias, target, generation: ++this.#generation, send: false, approve: false, stale: false };
    space.set(binding.alias, binding);
    this.#spaces.set(key, space);
    return this.#handle(key, binding);
  }

  list(context: ConversationKey): readonly BindingView[] {
    const space = this.#spaces.get(namespace(context));
    return [...(space?.values() ?? [])].map(b => ({ alias: b.alias, generation: b.generation,
      target: { ...b.target }, rights: ['read', ...(b.send ? ['send' as const] : []), ...(b.approve ? ['approve' as const] : [])], stale: b.stale }));
  }

  /** Selector is an alias OR project name; multiple enrolled peers require clarification. */
  resolve(context: ConversationKey, selector: string, current: readonly TargetEpoch[]): BindingHandle {
    const key = namespace(context);
    if (!text(selector)) fail('INVALID_INPUT');
    const matches = [...(this.#spaces.get(key)?.values() ?? [])]
      .filter(b => b.alias === selector || b.target.project === selector);
    if (!matches.length) fail('NOT_ALLOWED');
    if (matches.length !== 1) fail('AMBIGUOUS_TARGET');
    this.#active(matches[0], current);
    return this.#handle(key, matches[0]);
  }

  authorize(context: ConversationKey, handle: BindingHandle, right: Right, current: readonly TargetEpoch[]): TargetEpoch {
    if (right !== 'read' && right !== 'send' && right !== 'approve') fail('UNSUPPORTED_RIGHT');
    const { binding } = this.#binding(context, handle);
    this.#active(binding, current);
    if (right === 'approve' && !binding.approve) fail('APPROVE_NOT_GRANTED');
    if (right === 'send' && !binding.send) fail('SEND_NOT_GRANTED');
    return { ...binding.target }; // A decision/snapshot, not a delivery or live freshness guarantee.
  }

  grantSend(context: ConversationKey, handle: BindingHandle, current: readonly TargetEpoch[]): BindingHandle {
    const { key, binding } = this.#binding(context, handle);
    this.#active(binding, current);
    if (!binding.send) { binding.send = true; binding.generation = ++this.#generation; }
    return this.#handle(key, binding);
  }

  grantApprove(context: ConversationKey, handle: BindingHandle, current: readonly TargetEpoch[]): BindingHandle {
    const { key, binding } = this.#binding(context, handle);
    this.#active(binding, current);
    if (!binding.approve) { binding.approve = true; binding.generation = ++this.#generation; }
    return this.#handle(key, binding);
  }

  revokeApprove(context: ConversationKey, handle: BindingHandle): BindingHandle {
    const { key, binding } = this.#binding(context, handle);
    if (binding.approve) { binding.approve = false; binding.generation = ++this.#generation; }
    return this.#handle(key, binding);
  }

  revokeSend(context: ConversationKey, handle: BindingHandle): BindingHandle {
    const { key, binding } = this.#binding(context, handle);
    if (binding.send) { binding.send = false; binding.generation = ++this.#generation; }
    return this.#handle(key, binding);
  }

  revoke(context: ConversationKey, handle: BindingHandle): void {
    const { key, binding } = this.#binding(context, handle);
    const space = this.#spaces.get(key)!;
    space.delete(binding.alias);
    if (!space.size) this.#spaces.delete(key);
  }

  /** Explicit reviewed replacement, never alias-based auto-retarget; resets send. */
  rebind(context: ConversationKey, handle: BindingHandle, target: TargetEpoch, current: readonly TargetEpoch[]): BindingHandle {
    const { key, binding } = this.#binding(context, handle);
    const replacement = epoch(target);
    this.#current(replacement, current);
    if ([...this.#spaces.get(key)!.values()].some(b => b !== binding && sameEpoch(b.target, replacement))) fail('INVALID_INPUT');
    binding.target = replacement;
    binding.send = false;
    binding.approve = false;
    binding.stale = false;
    binding.generation = ++this.#generation;
    return this.#handle(key, binding);
  }
}
