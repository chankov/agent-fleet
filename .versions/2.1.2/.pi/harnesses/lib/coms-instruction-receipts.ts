// Optional cooperative local S6a protocol. Owner matching is routing, not caller authentication.
import { redactSecrets } from './fleet-transcript-store.ts';
export type InstructionOwner = {
    project: string;
    peer: string;
    sessionId: string;
    startedAt: string;
};
export type TerminalReceipt = {
    version: 1;
    owner: InstructionOwner;
    wireId: string;
    state: 'result' | 'failed';
    text: string | null;
    truncated: boolean;
    observedAt: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, k: string[]) => Object.keys(v).length === k.length && k.every(x => Object.hasOwn(v, x));
export const validOwner = (v: unknown): v is InstructionOwner => object(v) && keys(v, ['project', 'peer', 'sessionId', 'startedAt']) && ['project', 'peer', 'sessionId'].every(k => typeof v[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v[k] as string) && !(v[k] as string).includes('..')) && typeof v.startedAt === 'string' && /^\d{4}-\d\d-\d\dT[0-9:.+-]+(?:Z|[+-]\d\d:\d\d)$/.test(v.startedAt) && Number.isFinite(Date.parse(v.startedAt));
export const sameOwner = (a: InstructionOwner, b: InstructionOwner) => ['project', 'peer', 'sessionId', 'startedAt'].every(k => a[k as keyof InstructionOwner] === b[k as keyof InstructionOwner]);
export const validWire = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function ownerOf(identity: {
    project: string;
    name: string;
    session_id: string;
    started_at: string;
}): InstructionOwner { return { project: identity.project, peer: identity.name, sessionId: identity.session_id, startedAt: identity.started_at }; }
export function validateInstructionTag(envelope: unknown, owner: InstructionOwner): boolean {
    if (!object(envelope) || !Object.hasOwn(envelope, 'instruction'))
        return false;
    const tag = envelope.instruction;
    if (!object(tag) || !keys(tag, ['version', 'owner']) || tag.version !== 1 || !validOwner(tag.owner) || !sameOwner(tag.owner, owner) || !validWire(envelope.msg_id) || typeof envelope.prompt !== 'string' || !envelope.prompt.trim() || Buffer.byteLength(envelope.prompt) > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(envelope.prompt) || envelope.response_schema != null)
        throw Error('instruction owner/version/payload mismatch');
    return true;
}
export function instructionReceipt(owner: InstructionOwner, wireId: string, response: unknown, error: unknown): TerminalReceipt {
    let text: string | null = null, truncated = false;
    if (!error && typeof response === 'string') {
        let input = response.slice(0, 16384);
        truncated = input.length < response.length;
        // An unterminated/truncated private key is still private.
        input = input.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi, '[REDACTED]');
        const cleaned = redactSecrets(input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
        let bytes = 0;
        text = '';
        for (const char of cleaned) {
            const n = Buffer.byteLength(char);
            if (bytes + n > 4096) {
                truncated = true;
                break;
            }
            text += char;
            bytes += n;
        }
    }
    return { version: 1, owner: { ...owner }, wireId, state: error ? 'failed' : 'result', text, truncated, observedAt: new Date().toISOString() };
}
export function validTerminal(v: unknown): v is TerminalReceipt { return object(v) && keys(v, ['version', 'owner', 'wireId', 'state', 'text', 'truncated', 'observedAt']) && v.version === 1 && validOwner(v.owner) && validWire(v.wireId) && (v.state === 'result' || v.state === 'failed') && (v.text === null || typeof v.text === 'string' && Buffer.byteLength(v.text) <= 4096) && typeof v.truncated === 'boolean' && typeof v.observedAt === 'string' && v.observedAt.length <= 40 && Number.isFinite(Date.parse(v.observedAt)); }
type Manager = {
    getLeafId?: () => string | null;
    getEntry?: (id: string) => unknown;
};
export function handleInstructionReceipt(envelope: unknown, socket: {
    write: (s: string) => unknown;
}, getOwner: () => InstructionOwner | null, manager: Manager | undefined): boolean {
    if (!object(envelope) || envelope.type !== 'instruction_receipt_request')
        return false;
    const owner = getOwner();
    let status: 'available' | 'unknown' | 'invalid' | 'stale' = 'unknown', receipt: TerminalReceipt | null = null;
    const valid = keys(envelope, ['type', 'msg_id', 'version', 'owner', 'wireId', 'sender_session', 'sender_endpoint']) && typeof envelope.msg_id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(envelope.msg_id) && envelope.version === 1 && validOwner(envelope.owner) && validWire(envelope.wireId);
    if (!valid)
        status = 'invalid';
    else if (!owner || !sameOwner(owner, envelope.owner as InstructionOwner))
        status = 'stale';
    else
        try {
            if (manager?.getLeafId && manager.getEntry) {
                const leaf = manager.getLeafId();
                let id = leaf;
                const seen = new Set<string>();
                for (let i = 0; id && i < 256; i++) {
                    if (seen.has(id))
                        break;
                    seen.add(id);
                    const e = manager.getEntry(id);
                    if (!object(e) || e.id !== id)
                        break;
                    if (e.type === 'custom' && e.customType === 'coms-instruction-receipt' && object(e.data) && e.data.wireId === envelope.wireId) {
                        if (validTerminal(e.data) && sameOwner(e.data.owner, owner)) {
                            const clean=instructionReceipt(owner,e.data.wireId,e.data.text,e.data.state==='failed'?'failed':null);
                            receipt = {...structuredClone(e.data),text:clean.text,truncated:e.data.truncated||clean.truncated};
                            status = 'available';
                        }
                        break; // Corrupt exact-wire evidence never falls back to nearby/older text.
                    }
                    id = typeof e.parentId === 'string' ? e.parentId : null;
                }
                if(manager.getLeafId()!==leaf){status='unknown';receipt=null;}
            }
        }
        catch {
            status = 'unknown';
            receipt = null;
        }
    const after = getOwner();
    if (!owner || !after || !sameOwner(owner, after)) {
        status = 'stale';
        receipt = null;
    }
    socket.write(JSON.stringify({ type: 'instruction_receipt_response', msg_id: typeof envelope.msg_id === 'string' ? envelope.msg_id.slice(0, 96) : '', version: 1, owner: after, status, receipt }) + '\n');
    return true;
}
