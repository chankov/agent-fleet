// Pilot-only accounting primitive, NOT runtime permission or verified pricing.
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export const PILOT_LIMITS = Object.freeze({ maxAttempts: 100, maxMicrousd: 5_000_000 });
export interface PilotBudgetBinding {
 pilotHash: string; corpusHash: string; pricingHash: string; maxAttemptMicrousd: number;
}
export interface PilotAttempt { readonly id: string; readonly attempt: number; readonly exampleId: string; }
type Io = Pick<typeof fs, 'lstatSync' | 'openSync' | 'closeSync' | 'fstatSync' | 'readFileSync' | 'writeSync' | 'fsyncSync' | 'unlinkSync'>;
interface Options { ledgerPath: string; binding: PilotBudgetBinding; create?: boolean; io?: Io; }
type Reservation = { kind: 'reserve'; id: string; attempt: number; exampleId: string; maxMicrousd: number };
const CAP_BYTES = 128 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const example = (v: unknown): v is string => typeof v === 'string' && /^P(?:0[1-9]|[1-3][0-9]|40)$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Requires a private operator-owned directory whose ancestors cannot be swapped by untrusted writers. */
export function createPilotBudget(options: Options) {
 const io = options.io ?? fs;
 if (!options.binding || !['pilotHash', 'corpusHash', 'pricingHash'].every(k => /^[a-f0-9]{64}$/.test(String(options.binding[k as keyof PilotBudgetBinding])))
  || !integer(options.binding.maxAttemptMicrousd) || options.binding.maxAttemptMicrousd <= 0
  || options.binding.maxAttemptMicrousd > PILOT_LIMITS.maxMicrousd) throw Error('Invalid pilot binding or worst-case USD cost');
 if (typeof options.ledgerPath !== 'string' || !isAbsolute(options.ledgerPath)) throw Error('Unsafe ledger path: absolute path required');
 const path = resolve(options.ledgerPath), lock = path + '.lock';
 const binding = Object.freeze({ pilotHash: options.binding.pilotHash, corpusHash: options.binding.corpusHash,
  pricingHash: options.binding.pricingHash, maxAttemptMicrousd: options.binding.maxAttemptMicrousd });
 const header = { kind: 'header', schema: 'task-triage-pilot-budget/v1', binding, limits: PILOT_LIMITS };
 let persistenceBlocked = false;
 const receipts = new WeakMap<object, Reservation>();

 function safe(target: string) {
  let parent = parse(target).root;
  for (const part of target.slice(parent.length).split('/')) {
   parent = join(parent, part);
   try { if (io.lstatSync(parent).isSymbolicLink()) throw Error('Unsafe symlink ledger/lock path'); }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
 }
 function regular(fd: number) {
  const s = io.fstatSync(fd);
  if (!s.isFile() || s.nlink !== 1 || s.size > CAP_BYTES) throw Error('Unsafe linked or oversized ledger');
 }
 function syncDirectory() {
  const fd = io.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
 }
 function write(fd: number, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
   const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
   if (written <= 0) throw Error('Ledger persistence write failed');
   offset += written;
  }
  io.fsyncSync(fd);
 }
 function read() {
  safe(path);
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try { regular(fd); text = io.readFileSync(fd, 'utf8'); } finally { io.closeSync(fd); }
  if (!text || !text.endsWith('\n') || Buffer.byteLength(text) > CAP_BYTES) throw Error('Partial or invalid ledger');
  let lines: any[];
  try {
   lines = text.slice(0, -1).split('\n').map(line => {
    const row = JSON.parse(line);
    // Our writer uses canonical compact JSON; reject duplicate keys/partial/extra whitespace.
    if (JSON.stringify(row) !== line) throw Error('noncanonical');
    return row;
   });
  } catch { throw Error('Invalid or ambiguous ledger'); }
  if (JSON.stringify(lines[0]) !== JSON.stringify(header)) throw Error('Invalid ledger binding or header');
  let attempts = 0, chargedMicrousd = 0, pending: Reservation | null = null, unknown = false;
  const ids = new Set<string>();
  for (const row of lines.slice(1)) {
   if (unknown) throw Error('Invalid ledger after unknown cost');
   if (row?.kind === 'reserve') {
    if (pending || row.attempt !== attempts + 1 || !uuid.test(String(row.id)) || ids.has(row.id) || !example(row.exampleId)
     || row.maxMicrousd !== binding.maxAttemptMicrousd || attempts >= PILOT_LIMITS.maxAttempts
     || chargedMicrousd + row.maxMicrousd > PILOT_LIMITS.maxMicrousd
     || Object.keys(row).sort().join(',') !== 'attempt,exampleId,id,kind,maxMicrousd') throw Error('Invalid reservation ledger');
    pending = row; ids.add(row.id); attempts++;
   } else if (row?.kind === 'settle') {
    if (!pending || row.id !== pending.id || row.attempt !== pending.attempt
     || Object.keys(row).sort().join(',') !== 'attempt,costMicrousd,id,kind'
     || row.costMicrousd !== null && (!integer(row.costMicrousd) || row.costMicrousd > pending.maxMicrousd)) throw Error('Invalid settlement ledger');
    if (row.costMicrousd === null) unknown = true;
    else { chargedMicrousd += row.costMicrousd; pending = null; }
   } else throw Error('Invalid or ambiguous ledger record');
  }
  return { attempts, chargedMicrousd, reservedMicrousd: pending?.maxMicrousd ?? 0, blocked: Boolean(pending), pending, unknown, bytes: Buffer.byteLength(text) };
 }
 function append(value: unknown, expectedBytes: number) {
  safe(path);
  const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try {
   regular(fd);
   if (io.fstatSync(fd).size !== expectedBytes || expectedBytes + Buffer.byteLength(JSON.stringify(value) + '\n') > CAP_BYTES) throw Error('Ledger changed or exceeded bound');
   write(fd, value);
  } catch (error) { persistenceBlocked = true; throw error; }
  finally { io.closeSync(fd); }
 }
 function exclusive<T>(operation: () => T): T {
  if (persistenceBlocked) throw Error('Pilot persistence blocked; operator inspection required');
  safe(lock);
  let fd: number;
  try { fd = io.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Pilot ledger locked; never steal or auto-recover lock'); throw error; }
  const identity = io.fstatSync(fd);
  try {
   // A failed settlement must survive reopen even when its bytes reached disk.
   try { write(fd, { schema: 'pilot-budget-lock/v1', owner: randomUUID() }); syncDirectory(); }
   catch (error) { persistenceBlocked = true; throw error; }
   return operation();
  } finally {
   io.closeSync(fd);
   // Persistence errors/crashes retain the fence; only remove our exact safe leaf.
   if (!persistenceBlocked) {
    try {
     const current = io.lstatSync(lock);
     if (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw Error('Pilot lock identity changed');
     io.unlinkSync(lock); syncDirectory();
    } catch (error) { persistenceBlocked = true; throw error; }
   }
  }
 }
 if (options.create) exclusive(() => {
  safe(path);
  const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { regular(fd); write(fd, header); syncDirectory(); }
  catch (error) { persistenceBlocked = true; throw error; }
  finally { io.closeSync(fd); }
 });
 read(); // Missing/partial/changed binding never creates a replacement ledger.
 return {
  snapshot() {
   const s = read();
   return { attempts: s.attempts, chargedMicrousd: s.chargedMicrousd, reservedMicrousd: s.reservedMicrousd, blocked: s.blocked || persistenceBlocked || fs.existsSync(lock) };
  },
  reserve(exampleId: string, signal?: AbortSignal): PilotAttempt {
   if (!example(exampleId)) throw Error('Invalid pilot example ID');
   if (signal?.aborted) throw Error('Pilot cancelled before reservation');
   return exclusive(() => {
    const s = read();
    if (s.blocked) throw Error('Unresolved or unknown attempt; explicit operator inspection required');
    if (s.attempts >= PILOT_LIMITS.maxAttempts) throw Error('Pilot physical attempt cap reached');
    if (s.chargedMicrousd + binding.maxAttemptMicrousd > PILOT_LIMITS.maxMicrousd) throw Error('Pilot USD cap cannot fit next reservation');
    if (signal?.aborted) throw Error('Pilot cancelled before reservation');
    const record: Reservation = { kind: 'reserve', id: randomUUID(), attempt: s.attempts + 1, exampleId, maxMicrousd: binding.maxAttemptMicrousd };
    append(record, s.bytes);
    const receipt = Object.freeze({ id: record.id, attempt: record.attempt, exampleId }); receipts.set(receipt, record);
    return receipt;
   });
  },
  settle(receipt: PilotAttempt, costMicrousd: number | null) {
   const reserved = receipt && receipts.get(receipt);
   if (!reserved) throw Error('Invalid, foreign or consumed reservation receipt');
   if (costMicrousd !== null && (!integer(costMicrousd) || costMicrousd > reserved.maxMicrousd)) throw Error('Invalid or over-reserved USD cost; reservation retained');
   exclusive(() => {
    const s = read();
    if (s.unknown || s.pending?.id !== reserved.id || s.pending.attempt !== reserved.attempt) throw Error('Stale reservation receipt');
    append({ kind: 'settle', id: reserved.id, attempt: reserved.attempt, costMicrousd }, s.bytes);
    receipts.delete(receipt);
   });
  },
 };
}
