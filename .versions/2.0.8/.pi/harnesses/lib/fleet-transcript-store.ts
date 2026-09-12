import fs from "node:fs";
import { dirname } from "node:path";

export type FleetTranscriptKind = "text" | "thinking" | "tool-start" | "tool-result";
export type FleetToolStatus = "success" | "error";

export interface FleetTranscriptEvent {
	kind: FleetTranscriptKind;
	title: string;
	content: string;
	timestamp: number;
	callId?: string;
	status?: FleetToolStatus;
	durationMs?: number;
	chunkIndex?: number;
	chunkCount?: number;
}

export interface FleetTranscriptRecord {
	event: FleetTranscriptEvent;
	startOffset: number;
	endOffset: number;
}

export interface FleetTranscriptPage {
	events: FleetTranscriptEvent[];
	records: FleetTranscriptRecord[];
	startOffset: number;
	nextOffset: number;
	eof: boolean;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_READ_BYTES = 1024 * 1024;
const EVENT_CONTENT_BYTES = 64 * 1024;
const REDACTED = "[REDACTED]";

/** Remove common credential forms before transcript data reaches disk or UI. */
export function redactSecrets(value: string): string {
	const credential = "(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)";
	return value
		.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, REDACTED)
		.replace(/(["']authorization["']\s*:\s*["']bearer\s+)[^"']+/gi, `$1${REDACTED}`)
		.replace(new RegExp(`(["']?)([A-Z0-9_]*${credential})\\1(\\s*[:=]\\s*)(["'])(.*?)\\4`, "gi"), (_match, quote, key, separator, valueQuote) => `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`)
		.replace(/(\bauthorization\s*:\s*bearer\s+)[^\s"']+/gi, `$1${REDACTED}`)
		.replace(new RegExp(`(\\b[A-Z0-9_]*${credential}\\b\\s*=\\s*)(["']?)[^\\s,"';&]+\\2`, "gi"), `$1${REDACTED}`)
		.replace(new RegExp(`(\\b${credential}\\b\\s*[:=]\\s*)(["']?)[^\\s,"';&]+\\2`, "gi"), `$1${REDACTED}`)
		.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
		.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, REDACTED)
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
}

/** Defence-in-depth redaction for records entering or leaving the store. */
export function redactTimelineEvent(event: FleetTranscriptEvent): FleetTranscriptEvent {
	return {
		kind: event.kind,
		title: redactSecrets(event.title),
		content: redactSecrets(event.content),
		timestamp: event.timestamp,
		...(event.callId ? { callId: redactSecrets(event.callId) } : {}),
		...(event.status ? { status: event.status } : {}),
		...(event.durationMs == null ? {} : { durationMs: event.durationMs }),
		...(event.chunkIndex == null ? {} : { chunkIndex: event.chunkIndex }),
		...(event.chunkCount == null ? {} : { chunkCount: event.chunkCount }),
	};
}

function validEvent(value: unknown): value is FleetTranscriptEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return (event.kind === "text" || event.kind === "thinking" || event.kind === "tool-start" || event.kind === "tool-result")
		&& typeof event.title === "string"
		&& typeof event.content === "string"
		&& typeof event.timestamp === "number"
		&& Number.isFinite(event.timestamp)
		&& (event.callId === undefined || typeof event.callId === "string")
		&& (event.status === undefined || event.status === "success" || event.status === "error")
		&& (event.durationMs === undefined || (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0))
		&& (event.chunkIndex === undefined || (Number.isInteger(event.chunkIndex) && (event.chunkIndex as number) >= 0))
		&& (event.chunkCount === undefined || (Number.isInteger(event.chunkCount) && (event.chunkCount as number) > 0));
}

function contentChunks(content: string, maxBytes = EVENT_CONTENT_BYTES): string[] {
	if (Buffer.byteLength(content) <= maxBytes) return [content];
	const chunks: string[] = [];
	let current = "";
	let bytes = 0;
	for (const char of content) {
		const size = Buffer.byteLength(char);
		if (bytes + size > maxBytes && current) {
			chunks.push(current);
			current = "";
			bytes = 0;
		}
		current += char;
		bytes += size;
	}
	if (current || chunks.length === 0) chunks.push(current);
	return chunks;
}

function secureDirectory(path: string): void {
	fs.mkdirSync(path, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(path, 0o700); } catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

function secureAppend(path: string, text: string): void {
	secureDirectory(dirname(path));
	try {
		if (fs.lstatSync(path).isSymbolicLink()) throw new Error(`Refused transcript symlink: ${path}`);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
	const fd = fs.openSync(path, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
	try {
		try { fs.fchmodSync(fd, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
		fs.writeSync(fd, text, undefined, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

export interface FleetTranscriptStore {
	readonly path: string;
	append(event: FleetTranscriptEvent): void;
	read(options?: { after?: number; limit?: number; maxBytes?: number }): FleetTranscriptPage;
}

/** Create an append-only, owner-readable local transcript. */
export function createFleetTranscriptStore(path: string): FleetTranscriptStore {
	return {
		path,
		append(event) {
			const safe = redactTimelineEvent(event);
			const chunks = contentChunks(safe.content);
			const records = chunks.map((content, chunkIndex) => JSON.stringify({
				...safe,
				content,
				...(chunks.length > 1 ? { chunkIndex, chunkCount: chunks.length } : {}),
			})).join("\n") + "\n";
			secureAppend(path, records);
		},
		read: (options) => readFleetTranscript(path, options),
	};
}

/** Read complete JSONL records from a byte cursor without consuming a partial tail. */
export function readFleetTranscript(path: string, options: { after?: number; limit?: number; maxBytes?: number } = {}): FleetTranscriptPage {
	const after = Math.max(0, Math.floor(options.after ?? 0));
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
	const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_READ_BYTES));
	let size: number;
	try { size = fs.statSync(path).size; } catch (error: any) {
		if (error?.code === "ENOENT") return { events: [], records: [], startOffset: after, nextOffset: after, eof: true };
		throw error;
	}
	if (after >= size) return { events: [], records: [], startOffset: after, nextOffset: after, eof: true };
	const length = Math.min(maxBytes, size - after);
	const fd = fs.openSync(path, "r");
	let buffer: Buffer;
	try {
		buffer = Buffer.alloc(length);
		const read = fs.readSync(fd, buffer, 0, length, after);
		buffer = buffer.subarray(0, read);
	} finally {
		fs.closeSync(fd);
	}
	const lastNewline = buffer.lastIndexOf(0x0a);
	if (lastNewline < 0) return { events: [], records: [], startOffset: after, nextOffset: after, eof: false };
	const complete = buffer.subarray(0, lastNewline + 1).toString("utf8");
	const events: FleetTranscriptEvent[] = [];
	const records: FleetTranscriptRecord[] = [];
	let consumed = 0;
	for (const line of complete.split("\n")) {
		if (!line) continue;
		const lineBytes = Buffer.byteLength(line) + 1;
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { consumed += lineBytes; continue; }
		if (validEvent(parsed)) {
			const event = redactTimelineEvent(parsed);
			events.push(event);
			records.push({ event, startOffset: after + consumed, endOffset: after + consumed + lineBytes });
		}
		consumed += lineBytes;
		if (events.length >= limit) break;
	}
	const nextOffset = after + consumed;
	return { events, records, startOffset: records[0]?.startOffset ?? after, nextOffset, eof: nextOffset >= size };
}

/** Read the last complete records at or before a byte cursor. */
export function readFleetTranscriptBefore(path: string, options: { before?: number; limit?: number; maxBytes?: number } = {}): FleetTranscriptPage {
	let size: number;
	try { size = fs.statSync(path).size; } catch (error: any) {
		if (error?.code === "ENOENT") return { events: [], records: [], startOffset: 0, nextOffset: 0, eof: true };
		throw error;
	}
	const before = Math.max(0, Math.min(size, Math.floor(options.before ?? size)));
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
	const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_READ_BYTES));
	if (before === 0) return { events: [], records: [], startOffset: 0, nextOffset: 0, eof: size === 0 };
	const start = Math.max(0, before - maxBytes);
	const fd = fs.openSync(path, "r");
	let buffer: Buffer;
	try {
		buffer = Buffer.alloc(before - start);
		const read = fs.readSync(fd, buffer, 0, buffer.length, start);
		buffer = buffer.subarray(0, read);
	} finally { fs.closeSync(fd); }
	let localStart = start === 0 ? 0 : buffer.indexOf(0x0a) + 1;
	if (localStart < 0) localStart = buffer.length;
	const records: FleetTranscriptRecord[] = [];
	let cursor = localStart;
	while (cursor < buffer.length) {
		const newline = buffer.indexOf(0x0a, cursor);
		if (newline < 0) break;
		const line = buffer.subarray(cursor, newline).toString("utf8");
		try {
			const parsed = JSON.parse(line);
			if (validEvent(parsed)) {
				const event = redactTimelineEvent(parsed);
				records.push({ event, startOffset: start + cursor, endOffset: start + newline + 1 });
			}
		} catch {}
		cursor = newline + 1;
	}
	const selected = records.slice(-limit);
	return {
		events: selected.map(record => record.event),
		records: selected,
		startOffset: selected[0]?.startOffset ?? before,
		nextOffset: before,
		eof: before >= size,
	};
}

/** Open a bounded window at the current transcript tail. */
export function readFleetTranscriptTail(path: string, options: { limit?: number; maxBytes?: number } = {}): FleetTranscriptPage {
	return readFleetTranscriptBefore(path, { ...options, before: undefined });
}
