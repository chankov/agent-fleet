import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
	try {
		writeExclusive(file, record);
		return { file, record };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const existing = readRecord(file);
	if (existing && pidAlive(existing.pid)) throw new WriterLeaseHeldError(existing, file);
	try { unlinkSync(file); } catch { /* stolen or already gone */ }
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
}

export function releaseWriterLease(handle: WriterLeaseHandle): void {
	const existing = readRecord(handle.file);
	if (!existing) return;
	if (existing.pid !== handle.record.pid || existing.owner !== handle.record.owner) return;
	try { unlinkSync(handle.file); } catch { /* already gone */ }
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
