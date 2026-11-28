/**
 * Task brief: one file per task that every delegated agent receives as an input
 * artifact, so the task's truth does not depend on what survived in a context.
 *
 * The Hub owns the runtime section and regenerates it before each delegation.
 * The operator owns the notes section; it survives every regeneration. Children
 * only read the file. Briefs are working files: a new task's brief replaces the
 * previous task's, and session start archives the artifacts root as before.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const BRIEF_KIND = "briefs";
export const NOTES_MARKER = "<!-- operator notes: the Hub keeps everything below this line; edit freely -->";
const NOTES_PLACEHOLDER = "_(none yet: record decisions, constraints and open questions here)_";
const MAX_TEXT = 400;

export interface BriefRequirement { id: string; status: string; text: string; source?: string }
export interface BriefDelegation { agent: string; kind: "specialist" | "research"; status: string; task: string; scope?: readonly string[] }
export interface BriefInput {
	taskId: string;
	tier: string;
	risk?: string;
	scope?: string;
	requirements: readonly BriefRequirement[];
	delegations: readonly BriefDelegation[];
}

const clip = (value: string) => {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

/** File-safe name for a task id; distinct ids stay distinct. */
export function briefFileName(taskId: string): string {
	const safe = String(taskId || "task").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96) || "task";
	return `task-${safe}.md`;
}

/** The operator's notes from an existing brief, or null when there is no marker. */
export function extractOperatorNotes(existing: string | null | undefined): string | null {
	if (!existing) return null;
	const at = existing.indexOf(NOTES_MARKER);
	if (at < 0) return null;
	const notes = existing.slice(at + NOTES_MARKER.length).replace(/^\n+/, "").replace(/\s+$/, "");
	return notes && notes !== NOTES_PLACEHOLDER ? notes : null;
}

export function renderTaskBrief(input: BriefInput, operatorNotes: string | null = null): string {
	const requirements = input.requirements.length
		? input.requirements.map(r => `- ${r.id} [${r.status}] ${clip(r.text)}${r.source ? ` (source: ${clip(r.source)})` : ""}`).join("\n")
		: "- none recorded yet";
	const delegations = input.delegations.length
		? input.delegations.map(d => `- ${d.agent} (${d.kind}, ${d.status})${d.scope?.length ? ` scope: ${d.scope.join(", ")}` : ""} — ${clip(d.task) || "(no task text)"}`).join("\n")
		: "- none yet";
	return [
		`# Task brief — ${input.taskId}`,
		"",
		"Read this before starting. It is the shared record for the current task; your own task text says what *you* must do.",
		"Only the operator edits this file. Do not write to it.",
		"",
		"## Task state (maintained by the Hub)",
		`- tier: ${input.tier}; risk: ${input.risk ?? "unknown"}; scope: ${input.scope ?? "unknown"}`,
		"",
		"## Requirements (assertion ledger; recorded status, not fresh verification)",
		requirements,
		"",
		"## Delegations in this task",
		delegations,
		"",
		"## Operator notes",
		NOTES_MARKER,
		operatorNotes ?? NOTES_PLACEHOLDER,
		"",
	].join("\n");
}

/**
 * Writes the current task's brief under `<artifactsRoot>/briefs/`, preserving the
 * operator's notes, and removes briefs of earlier tasks. Returns the brief path.
 * The write is atomic (temp file + rename) so a reader never sees half a brief.
 */
export function refreshTaskBrief(artifactsRoot: string, input: BriefInput): string {
	const dir = path.join(artifactsRoot, BRIEF_KIND);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = briefFileName(input.taskId);
	const file = path.join(dir, name);
	let existing: string | null = null;
	try { existing = existsSync(file) ? readFileSync(file, "utf-8") : null; } catch { existing = null; }
	const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
	writeFileSync(temp, renderTaskBrief(input, extractOperatorNotes(existing)), { encoding: "utf-8", mode: 0o600 });
	renameSync(temp, file);
	for (const entry of readdirSync(dir)) {
		if (entry === name || !/^task-.*\.md$/.test(entry)) continue;
		try { rmSync(path.join(dir, entry), { force: true }); } catch { /* a stale brief is harmless */ }
	}
	return file;
}
