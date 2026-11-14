// One bounded, addressed attempt. No retry, retarget, polling or legacy prompt fallback.
import { lstat, mkdtemp, chmod, rm } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { TargetEpoch } from './fleet-codex-allowlist.ts';
import type { Outcome } from './fleet-codex-instruction-store.ts';
import { validInstruction, validInstructionTarget } from './fleet-codex-instruction-store.ts';
import { sameOwner, validOwner, validWire, validTerminal, type TerminalReceipt } from '../../../harnesses/lib/coms-instruction-receipts.ts';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export class InstructionTransportError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; }
}
function fail(code: string): never { throw new InstructionTransportError(code); }
const outcome = (state: Outcome['state'], detail: string | null = null, r?: TerminalReceipt): Outcome => ({ state, detail, result: r?.text ?? null, truncated: r?.truncated ?? false });
export class InstructionTransport {
    readonly #root: string;
    readonly #timeout: number;
    readonly #wait: number;
    constructor(options: {
        registryRoot: string;
        timeoutMs?: number;
        resultWaitMs?: number;
    }) { if (!isAbsolute(options.registryRoot) || resolve(options.registryRoot) !== options.registryRoot)
        fail('UNSAFE_PATH'); this.#root = options.registryRoot; this.#timeout = options.timeoutMs ?? 1500; this.#wait = options.resultWaitMs ?? 1500; if (!Number.isInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 1500 || !Number.isInteger(this.#wait) || this.#wait < 0 || this.#wait > 1500)
        fail('INVALID_TRANSPORT_OPTIONS'); }
    async #endpoint(target: TargetEpoch) { if (!validInstructionTarget(target))
        fail('INVALID_TARGET'); for (const p of [this.#root, join(this.#root, 'sockets')]) {
        const s = await lstat(p);
        if (!s.isDirectory() || s.isSymbolicLink())
            fail('UNSAFE_PATH');
    } const path = join(this.#root, 'sockets', target.sessionId + '.sock'), stat = await lstat(path); if (!stat.isSocket() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid())
        fail('UNSAFE_PATH'); return { path, dev: stat.dev, ino: stat.ino }; }
    #request(path: string, envelope: Record<string, unknown>, beforeWrite?: () => Promise<void>, signal?: AbortSignal): Promise<Record<string, any>> {
        return new Promise((yes, no) => {
            let done = false, buffer = Buffer.alloc(0);
            const socket = createConnection(path);
            const finish = (e?: unknown, value?: Record<string, any>) => { if (done)
                return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); e ? no(e) : yes(value!); };
            const abort = () => finish(new InstructionTransportError('CANCELLED'));
            const timer = setTimeout(() => finish(new InstructionTransportError('RPC_TIMEOUT')), this.#timeout);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            socket.once('connect', () => { void (async () => { try {
                await beforeWrite?.();
                if (done || signal?.aborted)
                    return;
                socket.write(JSON.stringify(envelope) + '\n');
            }
            catch (e) {
                finish(e);
            } })(); });
            socket.on('data', (b: Buffer) => { if (buffer.length + b.length > 32768) {
                finish(new InstructionTransportError('RPC_INVALID'));
                return;
            } buffer = Buffer.concat([buffer, b]); const end = buffer.indexOf(10); if (end < 0)
                return; try {
                const r: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
                if (!object(r) || r.msg_id !== envelope.msg_id)
                    fail('RPC_INVALID');
                finish(undefined, r);
            }
            catch (e) {
                finish(e);
            } });
            socket.once('error', () => finish(new InstructionTransportError('RPC_UNAVAILABLE')));
            socket.once('close', () => finish(new InstructionTransportError('RPC_UNAVAILABLE')));
        });
    }
    async #capability(target: TargetEpoch, signal?: AbortSignal) { const ep = await this.#endpoint(target), msg_id = randomUUID(); const r = await this.#request(ep.path, { type: 'ping', msg_id, sender_session: 'local-codex-instruction', sender_endpoint: '', hops: 0, timestamp: new Date().toISOString() }, undefined, signal); if (r.type !== 'pong' || !object(r.instruction) || r.instruction.version !== 1 || !validOwner(r.instruction.owner) || !sameOwner(r.instruction.owner, target))
        fail('INSTRUCTION_UNSUPPORTED'); return ep; }
    async capability(target: TargetEpoch) { await this.#capability(target); return true; }
    async receipt(target: TargetEpoch, wireId: string, signal?: AbortSignal): Promise<TerminalReceipt | null> { if (!validWire(wireId))
        fail('INVALID_WIRE'); const ep = await this.#capability(target, signal); const r = await this.#request(ep.path, { type: 'instruction_receipt_request', version: 1, msg_id: randomUUID(), owner: target, wireId, sender_session: 'local-codex-instruction', sender_endpoint: '' }, undefined, signal); if (r.type !== 'instruction_receipt_response' || r.version !== 1 || !validOwner(r.owner) || !sameOwner(r.owner, target))
        fail('RECEIPT_INVALID'); if (r.status === 'unknown')
        return null; if (r.status !== 'available' || !validTerminal(r.receipt) || r.receipt.wireId !== wireId || !sameOwner(r.receipt.owner, target))
        fail('RECEIPT_INVALID'); return r.receipt; }
    async send(target: TargetEpoch, wireId: string, text: string, options: {
        beforeWrite: () => Promise<void>;
        signal?: AbortSignal;
    }): Promise<Outcome> {
        if (!validWire(wireId) || !validInstruction(text))
            fail('INVALID_INSTRUCTION');
        let writeStarted = false, dir: string | undefined;
        const connections = new Set<Socket>();
        let terminal: TerminalReceipt | null = null;
        let wake: () => void = () => { };
        const arrived = new Promise<void>(r => wake = r);
        let server: ReturnType<typeof createServer> | undefined;
        try {
            if (options.signal?.aborted)
                return outcome('not_sent', 'CANCELLED');
            const endpoint = await this.#capability(target, options.signal);
            dir = await mkdtemp(join(tmpdir(), 'afi-'));
            await chmod(dir, 0o700);
            const reply = join(dir, 'r.sock');
            server = createServer(s => { if (connections.size >= 4) {
                s.destroy();
                return;
            } connections.add(s); s.on('error', () => { }); s.on('close', () => connections.delete(s)); let b = Buffer.alloc(0); s.on('data', (chunk: Buffer) => { if (b.length + chunk.length > 32768) {
                s.destroy();
                return;
            } b = Buffer.concat([b, chunk]); const end = b.indexOf(10); if (end < 0)
                return; try {
                const r: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end)));
                if (!object(r) || r.type !== 'response' || r.msg_id !== wireId || r.sender_session !== target.sessionId || r.sender_endpoint !== endpoint.path || !object(r.instruction) || r.instruction.version !== 1 || !validOwner(r.instruction.owner) || !sameOwner(r.instruction.owner, target) || !validTerminal(r.instruction.receipt) || r.instruction.receipt.wireId !== wireId || !sameOwner(r.instruction.receipt.owner, target))
                    throw Error();
                terminal = r.instruction.receipt;
                s.end(JSON.stringify({ type: 'ack', msg_id: wireId }) + '\n');
                wake();
            }
            catch {
                s.destroy();
            } }); });
            await new Promise<void>((r, j) => { server!.once('error', j); server!.listen(reply, r); });
            await chmod(reply, 0o600);
            const ack = await this.#request(endpoint.path, { type: 'prompt', msg_id: wireId, sender_session: 'local-codex-instruction', sender_endpoint: reply, sender_name: 'Codex human instruction', sender_cwd: '', hops: 0, timestamp: new Date().toISOString(), prompt: text, instruction: { version: 1, owner: target } }, async () => {
                const current = await this.#endpoint(target);
                if (current.dev !== endpoint.dev || current.ino !== endpoint.ino)
                    fail('TARGET_CHANGED');
                await options.beforeWrite();
                if (options.signal?.aborted)
                    fail('CANCELLED');
                writeStarted = true;
            }, options.signal);
            if (terminal)
                return outcome((terminal as TerminalReceipt).state, null, terminal);
            if (ack.type !== 'ack' || !object(ack.instruction) || ack.instruction.version !== 1 || !validOwner(ack.instruction.owner) || !sameOwner(ack.instruction.owner, target) || !['submitted', 'queued'].includes(ack.instruction.admission))
                return outcome('unknown', 'ACK_INVALID');
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cancel = () => wake();
            options.signal?.addEventListener('abort', cancel, { once: true });
            try {
                await Promise.race([arrived, new Promise<void>(r => timer = setTimeout(r, this.#wait))]);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
                options.signal?.removeEventListener('abort', cancel);
            }
            return terminal ? outcome((terminal as TerminalReceipt).state, null, terminal) : outcome(ack.instruction.admission, options.signal?.aborted ? 'CANCELLED' : 'RESULT_NOT_OBSERVED');
        }
        catch (e) {
            return terminal ? outcome((terminal as TerminalReceipt).state, null, terminal) : outcome(writeStarted ? 'unknown' : 'not_sent', e instanceof InstructionTransportError ? e.code : 'DELIVERY_UNAVAILABLE');
        }
        finally {
            for (const s of connections)
                s.destroy();
            if (server)
                await new Promise<void>(r => server!.close(() => r()));
            if (dir)
                await rm(dir, { recursive: true, force: true });
        }
    }
}
