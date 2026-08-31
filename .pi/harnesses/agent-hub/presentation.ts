import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const THINKING_ABBREV: Record<string, string> = { off: "", minimal: "min", low: "low", medium: "med", high: "hi", xhigh: "xh" };

export function displayName(name: string): string {
	return name.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function extractAskUserQuestions(output: string): string[] {
	return extractMarkers(output, "ASK_USER");
}

export function extractNeedsResearch(output: string): string[] {
	return extractMarkers(output, "NEEDS_RESEARCH");
}

function extractMarkers(output: string, marker: string): string[] {
	const questions: string[] = [];
	const pattern = new RegExp(`^${marker}\\s*:\\s*(.+)$`, "i");
	for (const rawLine of output.split("\n")) {
		const question = rawLine.trim().match(pattern)?.[1]?.trim();
		if (question && !questions.includes(question)) questions.push(question);
	}
	return questions;
}

export function resolveThinkingLevel(raw?: string): string {
	if (!raw) return "off";
	const value = raw.trim().toLowerCase();
	if (VALID_THINKING_LEVELS.has(value)) return value;
	return ["on", "true", "yes", "1"].includes(value) ? "low" : "off";
}

export function abbrevThinking(level: string): string {
	return THINKING_ABBREV[level] ?? "";
}

export function resolveDelegateExtension(cwd: string): string | null {
	try {
		const extension = fileURLToPath(new URL("./delegate.ts", import.meta.url));
		if (existsSync(extension)) return extension;
	} catch {}
	const local = join(cwd, ".pi", "harnesses", "agent-hub", "delegate.ts");
	return existsSync(local) ? local : null;
}
