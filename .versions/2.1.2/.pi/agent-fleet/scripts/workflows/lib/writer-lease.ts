import { mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface WriterLeaseRecord {
	owner: string;
	pid: number;
	command: string;
	path: string;
	createdAt: string;
}

export interface WriterLeaseHandle {
	file: string;
	record: WriterLeaseRecord;
}

export class WriterLeaseHeldError extends Error {
	readonly record: WriterLeaseRecord;
	readonly file: string;
	constructor(record: WriterLeaseRecord, file: string) {
		super(`Writer lease held by ${record.owner} pid ${record.pid} (${record.command}) at ${file}`);
		this.name = "WriterLeaseHeldError";
		this.record = record;
		this.file = file;
	}
}

export function writerLeaseKey(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex");
}

export function writerLeaseFile(cwd: string): string {
	const real = realpathSync(cwd);
	return resolve(real, ".pi", "writer-leases", `${writerLeaseKey(cwd)}.lock`);
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRecord(file: string): WriterLeaseRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as WriterLeaseRecord;
		if (!value || typeof value.owner !== "string" || typeof value.command !== "string" || !Number.isInteger(value.pid)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function writeExclusive(file: string, record: WriterLeaseRecord): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
}

// Serialize both reclaim and release. Atomic wx on the final lease file is not
// enough: two stale readers can each unlink the other's newly acquired lease.
// An abandoned guard fails closed rather than allowing a second owner.
const RECOVERY_WAIT_MS = 20;
const RECOVERY_TIMEOUT_MS = 2000;
const recoveryWait = new Int32Array(new SharedArrayBuffer(4));

function withLeaseTransaction<T>(file: string, callback: () => T): T {
    mkdirSync(dirname(file), { recursive: true });
    const guard = file + ".recovery";
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    while (true) {
        try {
            mkdirSync(guard);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                const blocked = new Error("Writer lease recovery guard is busy or abandoned; inspect before retry") as Error & { code: string };
                blocked.code = "WRITER_LEASE_RECOVERY_BUSY";
                throw blocked;
            }
            Atomics.wait(recoveryWait, 0, 0, RECOVERY_WAIT_MS);
        }
    }
    try {
        return callback();
    } finally {
        rmdirSync(guard);
    }
}

export function acquireWriterLease(options: { cwd: string; owner: string; command: string; pid?: number }): WriterLeaseHandle {
	const path = realpathSync(options.cwd);
	const file = writerLeaseFile(options.cwd);
	const record: WriterLeaseRecord = {
		owner: options.owner,
		pid: options.pid ?? process.pid,
		command: options.command,
		path,
		createdAt: new Date().toISOString(),
	};
	return withLeaseTransaction(file, () => {
		try {
			writeExclusive(file, record);
			return { file, record };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const existing = readRecord(file);
		if (existing && pidAlive(existing.pid)) throw new WriterLeaseHeldError(existing, file);
		try { unlinkSync(file); } catch { /* stale or already gone */ }
		try {
			writeExclusive(file, record);
			return { file, record };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				const raced = readRecord(file);
				if (raced) throw new WriterLeaseHeldError(raced, file);
			}
			throw error;
		}
	});
}

export function releaseWriterLease(handle: WriterLeaseHandle): void {
	withLeaseTransaction(handle.file, () => {
		const existing = readRecord(handle.file);
		if (!existing) return;
		if (existing.pid !== handle.record.pid || existing.owner !== handle.record.owner) return;
		try { unlinkSync(handle.file); } catch { /* already gone */ }
	});
}

export function writerLeaseMode(file: string): number {
	return statSync(file).mode & 0o777;
}

export async function withWriterLease<T>(options: { cwd: string; owner: string; command: string; pid?: number }, body: (lease: WriterLeaseHandle) => Promise<T> | T): Promise<T> {
	const lease = acquireWriterLease(options);
	try {
		return await body(lease);
	} finally {
		releaseWriterLease(lease);
	}
}
