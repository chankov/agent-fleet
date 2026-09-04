import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const runNamespacePath: string = "../../../.pi/harnesses/agent-hub/run-namespace.js";
const { makeRunId } = await import(runNamespacePath) as { makeRunId(): string };

export type TraceEvent = Record<string, unknown> & { type: string; at: string; runId: string };

export class FlowTrace {
	readonly runId: string;
	readonly cwd: string;
	readonly directory: string;
	readonly file: string;
	private ended = false;

	constructor(options: { cwd?: string; runId?: string; command?: string[]; pid?: number } = {}) {
		this.runId = options.runId ?? makeRunId();
		this.cwd = resolve(options.cwd ?? process.cwd());
		this.directory = resolve(this.cwd, ".pi", "flow-sessions", this.runId);
		this.file = resolve(this.directory, "trace.jsonl");
		mkdirSync(this.directory, { recursive: true });
		this.write("run_start", { pid: options.pid ?? process.pid, command: options.command ?? process.argv });
	}

	write(type: string, data: Record<string, unknown> = {}): void {
		if (this.ended) return;
		const event: TraceEvent = { type, at: new Date().toISOString(), runId: this.runId, ...data };
		appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
		if (type === "run_end") this.ended = true;
	}

	events(): TraceEvent[] {
		return readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	}
}
