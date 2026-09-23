/**
 * Fake workers and System 1 checks for the opt-in C4 Pi entry.
 * Projections and timeline cards go through the production helpers.
 * No secrets, no provider payloads, no workspace config.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSystem1Card, formatSystem1DecisionCard } from "../../../.pi/harnesses/agent-hub/drift-judge.ts";
import { appendSystem1TimelineCard, appendTimelineEvent } from "../../../.pi/harnesses/agent-hub/timeline.ts";
import { createFleetTranscriptStore, type FleetTranscriptStore } from "../../../.pi/harnesses/lib/fleet-transcript-store.ts";
import type { System1CheckInput } from "../../../.pi/harnesses/lib/fleet-read-model.ts";
import type { TimelineEntry } from "../../../.pi/harnesses/agent-hub/ui/zoom.ts";

export const C4_OPT_IN = "AF_C4_PI_UI";
export const C4_SCENES = ["concurrent", "statuses", "fast", "cancel", "reopen", "cleanup", "narrow"] as const;
export type C4Scene = (typeof C4_SCENES)[number];

/** Flags verified against the installed `pi --help`. Do not add undocumented flags. */
export const C4_PI_ARGS = [
	"--offline",
	"--no-approve",
	"--no-extensions",
	"--no-tools",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-session",
	"-e",
] as const;

export interface C4Worker {
	key: string;
	def: { name: string; description: string; tools: string; systemPrompt: string; file: string };
	status: "idle" | "running" | "done" | "error";
	toolCount: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	histEntry: { startedAt: number; endedAt: number | null };
	runCount: number;
	dispatchId: string;
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	checks: System1CheckInput[];
}

export interface C4MockState {
	scene: C4Scene;
	root: string;
	workers: Map<string, C4Worker>;
	apply(scene: C4Scene, now?: number): void;
	live(): { active: System1CheckInput[]; completed: System1CheckInput[]; degraded: false };
	dispose(): void;
}

const baseDef = (name: string) => ({
	name,
	description: "C4 mock worker",
	tools: "",
	systemPrompt: "",
	file: "c4-mock",
});

function check(dispatchId: string, checkId: string, over: Partial<System1CheckInput>): System1CheckInput {
	return {
		dispatchId,
		attemptId: "attempt1",
		checkId,
		snapshotId: "snap1",
		evaluation: "evaluating",
		llm: "not_called",
		status: "unknown",
		reason: "fixture",
		elapsedMs: 400,
		effectiveMode: "shadow",
		configuredMode: "shadow",
		source: "none",
		applied: "no",
		outcome: "shadow",
		llmVerdict: "unknown",
		returnedModel: "none",
		stateVersion: "fixture",
		questionsVersion: "fixture",
		usage: "unknown",
		rule: "failures",
		...over,
	};
}

function worker(key: string, name: string, dispatchId: string, now: number): C4Worker {
	return {
		key,
		def: baseDef(name),
		status: "running",
		toolCount: 1,
		lastWork: "edit",
		contextPct: 20,
		contextTokens: 1,
		histEntry: { startedAt: now - 1000, endedAt: null },
		runCount: 1,
		dispatchId,
		timeline: [],
		checks: [],
	};
}

function resetTranscript(state: C4MockState, agent: C4Worker, scene: string): void {
	const path = join(state.root, `${agent.key}-${scene}.jsonl`);
	rmSync(path, { force: true });
	agent.timeline = [];
	agent.transcriptStore = createFleetTranscriptStore(path);
}

function writeCards(agent: C4Worker, status: string, choice: string, elapsedMs: number): void {
	const checkId = agent.checks[0]?.checkId ?? "fast";
	appendTimelineEvent(agent, {
		kind: "tool-start",
		title: "Tool: read",
		content: "src/a.ts",
		timestamp: 1,
		callId: "read-1",
	});
	appendSystem1TimelineCard(agent, formatSystem1Card({
		rule: "failures",
		effectiveMode: "shadow",
		checkId,
		attemptId: "attempt1",
		status,
		elapsedMs,
		statusChoice: choice,
		returnedModel: "none",
		stateVersion: "fixture",
		questionsVersion: "fixture",
	}));
	appendSystem1TimelineCard(agent, formatSystem1DecisionCard({
		checkId,
		attemptId: "attempt1",
		source: "none",
		outcome: "shadow",
		applied: "no",
		llmVerdict: "unknown",
	}));
	appendTimelineEvent(agent, { kind: "text", title: "Assistant", content: "worker text", timestamp: 4 });
}

export function createC4MockState(root = mkdtempSync(join(tmpdir(), "agent-fleet-c4-"))): C4MockState {
	const workers = new Map<string, C4Worker>();
	const state: C4MockState = {
		scene: "concurrent",
		root,
		workers,
		apply(scene, now = Date.now()) {
			state.scene = scene === "narrow" ? state.scene : scene;
			if (scene === "narrow") return;
			const ensure = (key: string, name: string, dispatchId: string) => {
				const existing = workers.get(key);
				if (existing) return existing;
				const created = worker(key, name, dispatchId, now);
				workers.set(key, created);
				return created;
			};
			const builder = ensure("builder", "Builder", "d-builder");
			const reviewer = ensure("reviewer", "Reviewer", "d-reviewer");
			for (const agent of [builder, reviewer]) {
				agent.toolCount = 1;
				agent.lastWork = "edit";
				agent.contextPct = 20;
			}
			if (scene === "statuses") {
				ensure("auditor", "Auditor", "d-auditor");
				ensure("scribe", "Scribe", "d-scribe");
			} else {
				workers.delete("auditor");
				workers.delete("scribe");
			}
			const stamp = (agent: C4Worker, status: C4Worker["status"], ended: boolean) => {
				agent.status = status;
				agent.histEntry = { startedAt: agent.histEntry.startedAt, endedAt: ended ? now : null };
			};
			if (scene === "concurrent" || scene === "fast" || scene === "statuses") {
				stamp(builder, "running", false);
				stamp(reviewer, "running", false);
			}
			if (scene === "concurrent") {
				builder.checks = [check(builder.dispatchId, "fast", { evaluation: "evaluating", llmRelation: "parallel", elapsedMs: 400 })];
				reviewer.checks = [check(reviewer.dispatchId, "fallback", { evaluation: "finished", status: "unavailable", llmRelation: "fallback", elapsedMs: 400, finishedAt: now })];
				resetTranscript(state, builder, scene);
				writeCards(builder, "unknown", "unknown", 400);
			} else if (scene === "statuses") {
				const auditor = workers.get("auditor")!;
				const scribe = workers.get("scribe")!;
				stamp(auditor, "running", false);
				stamp(scribe, "idle", true);
				auditor.toolCount = 1;
				auditor.lastWork = "edit";
				scribe.toolCount = 1;
				scribe.lastWork = "edit";
				builder.checks = [check(builder.dispatchId, "fast", { evaluation: "evaluating", llmRelation: "parallel" })];
				reviewer.checks = [check(reviewer.dispatchId, "fallback", { evaluation: "finished", status: "unavailable", llmRelation: "fallback", finishedAt: now })];
				auditor.checks = [check(auditor.dispatchId, "fast", { evaluation: "finished", status: "ok", statusChoice: "on_track", llmRelation: "parallel", elapsedMs: 402, finishedAt: now })];
				scribe.checks = [check(scribe.dispatchId, "fast", { evaluation: "finished", status: "cancelled", reason: "cancelled", llmRelation: "none", finishedAt: now })];
				resetTranscript(state, auditor, scene);
				writeCards(auditor, "ok", "on_track", 402);
			} else if (scene === "fast") {
				builder.checks = [check(builder.dispatchId, "fast", { evaluation: "finished", status: "ok", statusChoice: "on_track", llmRelation: "parallel", elapsedMs: 402, finishedAt: now })];
				reviewer.checks = [];
				resetTranscript(state, builder, scene);
				writeCards(builder, "ok", "on_track", 402);
			} else if (scene === "cancel" || scene === "cleanup") {
				stamp(builder, "idle", true);
				stamp(reviewer, "idle", true);
				builder.checks = [check(builder.dispatchId, "fast", { evaluation: "finished", status: "cancelled", reason: "cancelled", llmRelation: "none", finishedAt: now })];
				reviewer.checks = [];
				resetTranscript(state, builder, scene);
				writeCards(builder, "cancelled", "unknown", 400);
			} else if (scene === "reopen") {
				stamp(builder, "idle", true);
				stamp(reviewer, "idle", true);
				builder.checks = [];
				reviewer.checks = [];
				resetTranscript(state, builder, scene);
				builder.checks = [check(builder.dispatchId, "fast", { evaluation: "finished", status: "ok", statusChoice: "on_track", elapsedMs: 402, finishedAt: now })];
				writeCards(builder, "ok", "on_track", 402);
				builder.checks = [];
			}
		},
		live() {
			const active: System1CheckInput[] = [];
			const completed: System1CheckInput[] = [];
			for (const agent of workers.values()) {
				for (const item of agent.checks) {
					if (item.evaluation === "evaluating" && item.unused !== true) active.push(item);
					else completed.push(item);
				}
			}
			return { active, completed, degraded: false };
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
			workers.clear();
		},
	};
	state.apply("concurrent", Date.now());
	return state;
}
