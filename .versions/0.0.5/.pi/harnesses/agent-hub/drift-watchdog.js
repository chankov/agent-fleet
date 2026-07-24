// Drift watchdog — the pure policy core behind in-flight specialist
// observation. Layer 1 is deterministic rules over the child's tool event
// stream (zero tokens); a firing rule is an ESCALATION SIGNAL, not a verdict —
// the harness then asks a cheap LLM judge (layer 2) whether the run is still
// on task, and only a DRIFTING/STUCK verdict terminates it (`drift_stop`).
// Everything here is data + pure functions so the policy is unit-testable
// away from the harness.

import { checkScope } from "./scope-gate.js";

export const WATCHDOG_SETTINGS = ["on", "off", "auto"];
export const DEFAULT_WATCHDOG_SETTING = "auto";

/** "On", " AUTO " → canonical setting, or null when unrecognized. */
export function normalizeWatchdogSetting(value) {
	const v = String(value ?? "").trim().toLowerCase();
	return WATCHDOG_SETTINGS.includes(v) ? v : null;
}

/**
 * Is the watchdog armed for one dispatch? Precedence: the dispatch_agent
 * `watchdog` param (boolean) > the per-agent /watchdog override ("on"/"off")
 * > the hub-wide setting ("on"/"auto" arm, "off" disarms).
 */
export function resolveWatchdogActive(dispatchParam, agentOverride, hubSetting) {
	if (dispatchParam === true) return true;
	if (dispatchParam === false) return false;
	if (agentOverride === "on") return true;
	if (agentOverride === "off") return false;
	return normalizeWatchdogSetting(hubSetting) !== "off";
}

// Conservative thresholds: a false positive kills a productive run, so every
// rule needs sustained evidence before it fires.
export const DRIFT_DEFAULTS = {
	writeTools: ["write", "edit"],
	maxRepeats: 4,
	maxConsecutiveFailures: 5,
	maxToolCalls: 200,
	trailLimit: 60,
};

const pathFromArgs = (argStr) => {
	try {
		const args = JSON.parse(argStr || "{}");
		for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
			if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
		}
	} catch {}
	return null;
};

/**
 * Per-run monitor fed from the tool event stream. `onToolStart(tool, argStr)`
 * and `onToolEnd(tool, isError)` return `null` while the run looks healthy, or
 * `{ rule, detail }` when a rule crosses its threshold:
 *   scope    — a write-capable tool touched a path outside the declared scope
 *   loop     — the exact same (tool, args) call repeated maxRepeats times
 *   failures — maxConsecutiveFailures failed tool calls in a row
 *   toolcap  — maxToolCalls total tool calls in one run
 * Each rule instance fires once (at the crossing), so the caller escalates —
 * it never gets spammed. `trail(n)` returns the recent tool trail for the judge.
 */
export function createDriftMonitor(cfg = {}) {
	const scopeGlobs = (cfg.scopeGlobs || []).filter(Boolean);
	const writeTools = new Set(cfg.writeTools || DRIFT_DEFAULTS.writeTools);
	const maxRepeats = cfg.maxRepeats ?? DRIFT_DEFAULTS.maxRepeats;
	const maxConsecutiveFailures = cfg.maxConsecutiveFailures ?? DRIFT_DEFAULTS.maxConsecutiveFailures;
	const maxToolCalls = cfg.maxToolCalls ?? DRIFT_DEFAULTS.maxToolCalls;
	const trailLimit = cfg.trailLimit ?? DRIFT_DEFAULTS.trailLimit;

	const callCounts = new Map();
	const trailLines = [];
	let totalCalls = 0;
	let consecutiveFailures = 0;

	const pushTrail = (line) => {
		trailLines.push(line);
		if (trailLines.length > trailLimit) trailLines.shift();
	};

	return {
		onToolStart(toolName, argStr) {
			totalCalls++;
			pushTrail(`${toolName} ${String(argStr || "").slice(0, 120)}`.trim());

			if (scopeGlobs.length > 0 && writeTools.has(toolName)) {
				const path = pathFromArgs(argStr);
				if (path && checkScope([path], scopeGlobs).outOfScope.length > 0) {
					return { rule: "scope", detail: `${toolName} touched ${path} — outside the declared scope (${scopeGlobs.join(", ")})` };
				}
			}

			const fingerprint = `${toolName}::${argStr || ""}`;
			const count = (callCounts.get(fingerprint) || 0) + 1;
			callCounts.set(fingerprint, count);
			if (count === maxRepeats) {
				return { rule: "loop", detail: `${toolName} called ${count}× with identical arguments — likely stuck in a loop` };
			}

			if (totalCalls === maxToolCalls) {
				return { rule: "toolcap", detail: `${totalCalls} tool calls in one run — far beyond a focused task` };
			}
			return null;
		},

		onToolEnd(_toolName, isError) {
			if (isError === true) {
				consecutiveFailures++;
				pushTrail("  ↳ FAILED");
				if (consecutiveFailures % maxConsecutiveFailures === 0) {
					return { rule: "failures", detail: `${consecutiveFailures} consecutive failed tool calls — no forward progress` };
				}
			} else if (isError === false) {
				consecutiveFailures = 0;
			}
			// isError undefined: the stream carries no error flag — rule stays inert.
			return null;
		},

		trail(n = 40) {
			return trailLines.slice(-n);
		},
	};
}

/**
 * The one-shot judge prompt: original task + declared scope + recent trail +
 * the rule that fired. The judge answers with a single machine-parseable line.
 */
export function buildJudgePrompt({ agent, task, scopeGlobs = [], trail = [], violation }) {
	const scopeBlock = scopeGlobs.length > 0
		? `\n## Declared file scope\n${scopeGlobs.map(s => `- ${s}`).join("\n")}\n`
		: "";
	return `You are a drift watchdog judging whether a running coding agent is still on task.
Do not solve the task. Judge only whether the agent's recent actions serve it.

## Agent
${agent}

## Original task (verbatim)
${task}
${scopeBlock}
## Escalation signal
Rule "${violation?.rule || "unknown"}" fired: ${violation?.detail || "(no detail)"}

## Recent tool trail (oldest first)
${trail.length > 0 ? trail.join("\n") : "(no tool calls recorded)"}

## Your answer
Reply with EXACTLY one line, nothing else:
VERDICT: ON_TRACK — <why the actions still serve the task>
VERDICT: DRIFTING — <what the agent is doing instead of the task>
VERDICT: STUCK — <the loop or dead end it cannot escape>
Prefer ON_TRACK unless the trail clearly contradicts the task: false alarms kill
productive work.`;
}

/** Parse the judge's reply. Returns { verdict, reason } or null when unparseable. */
export function parseJudgeVerdict(text) {
	const matches = [...String(text ?? "").matchAll(/VERDICT:\s*(ON_TRACK|DRIFTING|STUCK)\s*(?:[—:-]\s*(.*))?/gi)];
	if (matches.length === 0) return null;
	const last = matches[matches.length - 1];
	return { verdict: last[1].toLowerCase(), reason: (last[2] || "").trim() };
}
