import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateMonitorEvent } from "./hermes-monitor-model.ts";

export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_MAX = 4096;

function mode(file: string): number { return fs.statSync(file).mode & 0o777; }

function safeFile(file: string): void {
	if (!path.isAbsolute(file)) throw new Error("event journal path must be absolute");
	const directory = path.dirname(file);
	if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || mode(directory) !== 0o700)) throw new Error("event journal directory is unsafe");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	if (!fs.existsSync(file)) return;
	const stat = fs.lstatSync(file);
	if (stat.isSymbolicLink() || !stat.isFile() || mode(file) !== 0o600) throw new Error("event journal is unsafe");
}

/** Persist only the monitor-event contract; arbitrary extra fields are never journaled. */
function safeEvent(value: unknown): any {
	const valid = validateMonitorEvent(value);
	if (!valid) return null;
	const event: any = {
		schema: valid.schema, schemaVersion: valid.schemaVersion, eventId: valid.eventId,
		eventSequence: valid.eventSequence, profileKey: valid.profileKey, hubInstanceId: valid.hubInstanceId,
		ownerId: valid.ownerId, occurredAt: valid.occurredAt, kind: valid.kind, materialKey: valid.materialKey,
	};
	if (valid.task) {
		event.task = { id: valid.task.id, generation: valid.task.generation };
		for (const key of ["parentId", "specialist", "fromState", "toState", "outputSequence"])
			if (valid.task[key] !== undefined) event.task[key] = valid.task[key];
	}
	return event;
}

export class MonitorEventJournal {
	private readonly file: string;
	private readonly now: () => Date;
	private events: any[] = [];
	private sequence = 0;
	private waiters = new Set<{ afterSequence: number; limit: number; resolve: (value: any) => void; timer: NodeJS.Timeout }>();

	constructor(options: { file: string; now?: () => Date }) {
		this.file = options.file;
		this.now = options.now ?? (() => new Date());
		safeFile(this.file);
		this.load();
	}

	private load(): void {
		if (!fs.existsSync(this.file)) return;
		const body = fs.readFileSync(this.file, "utf8");
		if (!body) return;
		const lines = body.split("\n");
		if (lines.at(-1) === "") lines.pop();
		for (const line of lines) {
			let event: any;
			try { event = safeEvent(JSON.parse(line)); } catch { throw new Error("event journal is torn or corrupt"); }
			if (!event) throw new Error("event journal is unsafe");
			if (!this.events.length) this.sequence = event.eventSequence - 1;
			if (event.eventSequence !== this.sequence + 1) throw new Error("event journal is unsafe");
			this.events.push(event);
			this.sequence = event.eventSequence;
		}
	}

	append(value: unknown): any {
		const event = safeEvent(value);
		if (!event || event.eventSequence !== this.sequence + 1) throw new Error("invalid event sequence");
		const fd = fs.openSync(this.file, "a", 0o600);
		try {
			fs.writeSync(fd, `${JSON.stringify(event)}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(this.file, 0o600);
		this.events.push(event);
		this.sequence = event.eventSequence;
		this.resolveWaiters();
		this.prune();
		return event;
	}

	private prune(): void {
		const cutoff = this.now().getTime() - EVENT_RETENTION_MS;
		const retained = this.events.filter(event => Date.parse(event.occurredAt) >= cutoff).slice(-EVENT_RETENTION_MAX);
		if (retained.length === this.events.length) return;
		const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		const fd = fs.openSync(temporary, "wx", 0o600);
		try {
			fs.writeSync(fd, retained.map(event => JSON.stringify(event)).join("\n") + (retained.length ? "\n" : ""));
			fs.fsyncSync(fd);
		} finally { fs.closeSync(fd); }
		fs.renameSync(temporary, this.file);
		const directoryFd = fs.openSync(path.dirname(this.file), "r");
		try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
		this.events = retained;
	}

	private result(afterSequence: number, limit: number, timedOut = false): any {
		const firstAvailableSequence = this.events[0]?.eventSequence ?? this.sequence + 1;
		if (afterSequence < firstAvailableSequence - 1) return { error: "cursor_too_old", snapshotRequired: true, firstAvailableSequence, latestSequence: this.sequence };
		return { firstAvailableSequence, latestSequence: this.sequence, items: this.events.filter(event => event.eventSequence > afterSequence).slice(0, limit), timedOut };
	}

	replay(afterSequence: number, limit: number, waitMs = 0, signal?: AbortSignal): any | Promise<any> {
		if (!Number.isInteger(afterSequence) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw new Error("invalid cursor");
		const immediate = this.result(afterSequence, limit);
		if (immediate.error || immediate.items.length || waitMs === 0) return immediate;
		return new Promise(resolve => {
			const waiter: any = { afterSequence, limit, resolve, timer: setTimeout(() => this.removeWaiter(waiter, true), waitMs) };
			this.waiters.add(waiter);
			if (signal?.aborted) { this.removeWaiter(waiter, false); return; }
			signal?.addEventListener("abort", () => this.removeWaiter(waiter, false), { once: true });
		});
	}

	cancelWaiter(waiter: unknown): void { this.removeWaiter(waiter as any, false); }
	private removeWaiter(waiter: any, timedOut: boolean): void {
		if (!this.waiters.delete(waiter)) return;
		clearTimeout(waiter.timer);
		waiter.resolve(this.result(waiter.afterSequence, waiter.limit, timedOut));
	}
	private resolveWaiters(): void {
		for (const waiter of [...this.waiters]) {
			const result = this.result(waiter.afterSequence, waiter.limit);
			if (result.error || result.items.length) this.removeWaiter(waiter, false);
		}
	}
	latestSequence(): number { return this.sequence; }
}
