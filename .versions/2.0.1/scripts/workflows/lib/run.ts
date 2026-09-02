import type { ChildProcess } from "node:child_process";
import type { PermissionSnapshot } from "./permissions.ts";
import { FlowTrace } from "./trace.ts";

export type PhaseKind = "engineer" | "agent" | "code";
export interface PhaseParams { name: string; kind: PhaseKind; owner: string; description: string; retries?: number }
export interface FinishResult { accepted: boolean; reason?: string; exitCode: number; status: "accepted" | "rejected"; banner: string; signal?: NodeJS.Signals }

function words(value: string): string[] {
	return value.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
}

export function validateDescription(name: string, description: string): void {
	if (!description.trim()) throw new Error("Phase description must explain why the phase exists");
	const nameWords = words(name);
	const descriptionWords = words(description).filter(word => !["a", "an", "the", "to", "of"].includes(word));
	if (nameWords.length > 0 && descriptionWords.join(" ") === nameWords.join(" ")) {
		throw new Error("Phase description must explain why, not merely repeat its name");
	}
}

export class PhaseContext {
	status: "fail" | "success" = "fail";
	readonly params: PhaseParams;
	private readonly trace: FlowTrace;
	constructor(params: PhaseParams, trace: FlowTrace) { this.params = params; this.trace = trace; }
	log(message: string, data: Record<string, unknown> = {}): void { this.trace.write("log", { phase: this.params.name, message, ...data }); }
}

export class Run {
	readonly trace: FlowTrace;
	readonly repositoryBaseline?: PermissionSnapshot;
	private finished = false;
	private phaseFailed = false;
	private lastResult?: FinishResult;
	private readonly cancellation = new AbortController();
	readonly signal = this.cancellation.signal;

	constructor(options: { cwd?: string; runId?: string; command?: string[]; trace?: FlowTrace; repositoryBaseline?: PermissionSnapshot } = {}) {
		this.trace = options.trace ?? new FlowTrace(options);
		this.repositoryBaseline = options.repositoryBaseline;
	}

	async phase<T>(params: PhaseParams, body: (phase: PhaseContext) => Promise<T> | T): Promise<T> {
		if (this.finished) throw new Error("Cannot start a phase after finish()");
		validateDescription(params.name, params.description);
		const retries = params.retries ?? 0;
		if (!Number.isInteger(retries) || retries < 0) throw new Error("Phase retries must be a non-negative integer");
		const phase = new PhaseContext(params, this.trace);
		this.trace.write("phase_start", { phase: params.name, kind: params.kind, owner: params.owner, description: params.description, retries, status: phase.status });
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const value = await body(phase);
				if (this.finished) throw new Error("Run ended while phase was active");
				phase.status = "success";
				this.trace.write("phase_end", { phase: params.name, status: phase.status, attempt: attempt + 1 });
				return value;
			} catch (error) {
				if (this.finished) throw error;
				const message = error instanceof Error ? error.message : String(error);
				this.trace.write("error", { phase: params.name, message, attempt: attempt + 1 });
				const terminal = typeof error === "object" && error !== null && (error as { terminal?: boolean }).terminal === true;
				if (attempt < retries && !terminal) {
					this.trace.write("log", { phase: params.name, message: "retrying failed phase", nextAttempt: attempt + 2 });
					continue;
				}
				this.phaseFailed = true;
				this.trace.write("phase_end", { phase: params.name, status: phase.status, attempt: attempt + 1, error: message });
				if (!this.finished) this.finalize(false, message);
				throw error;
			}
		}
		throw new Error("unreachable phase retry state");
	}

	registerProcess(process: ChildProcess, phase: string): void {
		this.trace.write("agent_process", { phase, pid: process.pid ?? null, processGroup: process.pid == null ? null : -process.pid });
	}

	finish(input: { accepted: boolean; reason?: string }): FinishResult {
		if (this.finished) throw new Error("finish() may be called exactly once");
		return this.finalize(input.accepted && !this.phaseFailed, input.reason);
	}

	abort(reason: string, exitCode = 1): FinishResult {
		this.cancellation.abort(reason);
		if (this.finished) return this.lastResult!;
		return this.finalize(false, reason, exitCode);
	}

	interrupt(signal: NodeJS.Signals): FinishResult {
		const exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
		this.cancellation.abort(signal);
		if (this.finished) return this.lastResult!;
		return this.finalize(false, `interrupted by ${signal}`, exitCode, signal);
	}

	private finalize(accepted: boolean, reason?: string, exitCode = accepted ? 0 : 1, signal?: NodeJS.Signals): FinishResult {
		this.finished = true;
		const status = accepted ? "accepted" : "rejected";
		const banner = accepted ? `FLOW ACCEPTED (${this.trace.runId})` : `FLOW REJECTED (${this.trace.runId})${reason ? `: ${reason}` : ""}`;
		this.lastResult = { accepted, reason, exitCode, status, banner, ...(signal ? { signal } : {}) };
		this.trace.write("run_end", { accepted, status, exitCode, reason: reason ?? "", banner, ...(signal ? { signal } : {}) });
		return this.lastResult;
	}
}
