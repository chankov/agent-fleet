import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MAX = 1000;

type InvokeStatus = "pending" | "accepted" | "rejected";
function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	throw new Error("invoke intent is not canonical JSON");
}

type InvokeRow = {
	requestId: string;
	hash: string;
	intent: { taskId: string; generation: number; action: string };
	status: InvokeStatus;
	at: string;
	orphaned?: boolean;
};

function safeIntent(intent: unknown): InvokeRow["intent"] {
	const value = intent as Record<string, unknown>;
	if (
		!value ||
		typeof value.taskId !== "string" ||
		!Number.isInteger(value.generation) ||
		typeof value.action !== "string"
	) throw new Error("invalid invoke intent");
	return { taskId: value.taskId, generation: value.generation as number, action: value.action };
}

/** Durable, bounded idempotency records. It never serializes request parameters or credentials. */
export class MonitorInvokeJournal {
	private readonly rows = new Map<string, InvokeRow>();
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
		if (!path.isAbsolute(file)) throw new Error("invoke journal path must be absolute");
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.chmodSync(path.dirname(file), 0o700);
		if (!fs.existsSync(file)) return;
		const stat = fs.lstatSync(file);
		if (stat.isSymbolicLink() || !stat.isFile() || (fs.statSync(file).mode & 0o777) !== 0o600) throw new Error("invoke journal unsafe");
		for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
			let row: InvokeRow;
			try {
				row = JSON.parse(line);
				if (!row.requestId || !row.hash || !row.status || !safeIntent(row.intent)) throw new Error();
			} catch {
				throw new Error("invoke journal torn");
			}
			this.rows.set(row.requestId, row.status === "pending" ? { ...row, orphaned: true } : row);
		}
	}

	static hash(intent: unknown): string {
		return crypto.createHash("sha256").update(canonicalJson(intent), "utf8").digest("hex");
	}

	admit(requestId: string, intent: unknown): { duplicate: boolean; row?: InvokeRow; error?: string } {
		const hash = MonitorInvokeJournal.hash(intent);
		const prior = this.rows.get(requestId);
		if (prior) {
			if (prior.hash !== hash) return { duplicate: false, error: "idempotency_conflict" };
			if (!prior.orphaned) return { duplicate: true, row: prior };
			const row = { ...prior, orphaned: false, at: new Date().toISOString() };
			this.rows.set(requestId, row);
			this.persist(row);
			return { duplicate: false, row };
		}
		const row: InvokeRow = { requestId, hash, intent: safeIntent(intent), status: "pending", at: new Date().toISOString() };
		this.rows.set(requestId, row);
		this.persist(row);
		return { duplicate: false, row };
	}

	result(requestId: string, status: Exclude<InvokeStatus, "pending">): InvokeRow {
		const row = this.rows.get(requestId);
		if (!row) throw new Error("unknown request");
		const next = { ...row, status, orphaned: false, at: new Date().toISOString() };
		this.rows.set(requestId, next);
		this.persist(next);
		return next;
	}

	private persist(row: InvokeRow): void {
		// Field-level allowlisting keeps identifiers such as "route-planner" valid.
		const clean: InvokeRow = {
			requestId: row.requestId,
			hash: row.hash,
			intent: safeIntent(row.intent),
			status: row.status,
			at: row.at,
			...(row.orphaned ? { orphaned: true } : {}),
		};
		fs.appendFileSync(this.file, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
		fs.chmodSync(this.file, 0o600);
		this.compact();
	}

	private compact(): void {
		const cutoff = Date.now() - RETENTION_MS;
		const pending = [...this.rows.values()].filter(row => row.status === "pending");
		const completed = [...this.rows.values()]
			.filter(row => row.status !== "pending" && Date.parse(row.at) >= cutoff)
			.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
			.slice(-RETENTION_MAX);
		const retained = [...pending, ...completed];
		this.rows.clear();
		for (const row of retained) this.rows.set(row.requestId, row);
		const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		const fd = fs.openSync(temporary, "wx", 0o600);
		try {
			fs.writeSync(fd, retained.map(row => JSON.stringify(row)).join("\n") + (retained.length ? "\n" : ""));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temporary, this.file);
		const directory = fs.openSync(path.dirname(this.file), "r");
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
	}
}
