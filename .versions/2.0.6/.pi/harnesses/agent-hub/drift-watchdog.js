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
 * Is the watchdog armed for one dispatch?
 * Operator (or omitted work mode): dispatch param > per-agent /af-watchdog
 * override ("on"/"off") > hub-wide setting ("on"/"auto" arm, "off" disarms).
 * Orchestrator: hub `off` or per-agent `off` still disarms; otherwise armed.
 * A specialist cannot pass `watchdog: false` to sneak around orchestrator.
 */
export function resolveWatchdogActive(dispatchParam, agentOverride, hubSetting, workMode) {
	if (workMode === "orchestrator") {
		if (normalizeWatchdogSetting(hubSetting) === "off") return false;
		if (agentOverride === "off") return false;
		return true;
	}
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

/** Session subtrees the hub itself tells specialists to write into. */
export const HUB_OWNED_SUBDIRS = ["artifacts", "findings", "delegations"];

/**
 * Globs for the paths the deliverable protocol ORDERS the specialist to write
 * (`artifacts/<kind>/<agentKey>-run<N>.md` and friends). A dispatcher's `scope:`
 * never lists them, so checking writes against the declared scope alone made the
 * hub punish obedience: `planner` was killed after 1088s and `documenter` after
 * 120s for writing exactly where they were told to.
 *
 * Pass every form the path can arrive in — the absolute session dir and its
 * repo-relative twin — since the specialist may use either.
 */
export function hubOwnedScopeGlobs(...sessionDirs) {
	const globs = [];
	for (const dir of sessionDirs) {
		const base = String(dir || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (!base) continue;
		for (const sub of HUB_OWNED_SUBDIRS) globs.push(`${base}/${sub}/**`);
	}
	return [...new Set(globs)];
}

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
 * `{ rule, terminal, detail }` when a rule crosses its threshold:
 *   scope    — a write-capable tool touched a path outside the declared scope
 *   loop     — the exact same (tool, args) call repeated maxRepeats times
 *   failures — maxConsecutiveFailures failed tool calls in a row
 *   toolcap  — maxToolCalls total tool calls in one run
 * Each rule instance fires once (at the crossing), so the caller escalates —
 * it never gets spammed. `trail(n)` returns the recent tool trail for the judge.
 *
 * `terminal: false` marks a signal that must never end a run on its own: the
 * post-run scope gate is advisory by design ("nothing is auto-reverted"), so the
 * live rule watching the same thing cannot be a death sentence. `scope` reports;
 * only the genuinely stuck rules stop work.
 */
export function createDriftMonitor(cfg = {}) {
	const scopeGlobs = (cfg.scopeGlobs || []).filter(Boolean);
	const allowGlobs = (cfg.allowGlobs || []).filter(Boolean);
	// A path in EITHER the declared scope or the hub-owned allowlist is in scope.
	const effectiveScope = [...scopeGlobs, ...allowGlobs];
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
				if (path && checkScope([path], effectiveScope).outOfScope.length > 0) {
					return {
						rule: "scope",
						terminal: false,
						detail: `${toolName} touched ${path} — outside the declared scope (${scopeGlobs.join(", ")})`,
					};
				}
			}

			const fingerprint = `${toolName}::${argStr || ""}`;
			const count = (callCounts.get(fingerprint) || 0) + 1;
			callCounts.set(fingerprint, count);
			if (count === maxRepeats) {
				return { rule: "loop", terminal: true, detail: `${toolName} called ${count}× with identical arguments — likely stuck in a loop` };
			}

			if (totalCalls === maxToolCalls) {
				return { rule: "toolcap", terminal: true, detail: `${totalCalls} tool calls in one run — far beyond a focused task` };
			}
			return null;
		},

		onToolEnd(_toolName, isError) {
			if (isError === true) {
				consecutiveFailures++;
				pushTrail("  ↳ FAILED");
				if (consecutiveFailures % maxConsecutiveFailures === 0) {
					return { rule: "failures", terminal: true, detail: `${consecutiveFailures} consecutive failed tool calls — no forward progress` };
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
export function buildJudgePrompt({ agent, task, scopeGlobs = [], hubOwnedGlobs = [], trail = [], violation }) {
	const scopeBlock = scopeGlobs.length > 0
		? `\n## Declared file scope\n${scopeGlobs.map(s => `- ${s}`).join("\n")}\n`
		: "";
	// Without this block the judge reads a protocol-mandated artifact write as
	// rogue behaviour and answers DRIFTING — which is how obedient runs got killed.
	const hubOwnedBlock = hubOwnedGlobs.length > 0
		? `\n## Hub-owned paths (writing here is REQUIRED, never drift)\nThe dispatcher orders every specialist to write its deliverable to these paths. ` +
			`They are outside the declared scope by design — treat writes here as on-task:\n${hubOwnedGlobs.map(s => `- ${s}`).join("\n")}\n`
		: "";
	const advisoryBlock = violation?.terminal === false
		? `\nThis signal is ADVISORY: it cannot stop the run by itself. Answer honestly about the whole trail, ` +
			`not about this one write.\n`
		: "";
	return `You are a drift watchdog judging whether a running coding agent is still on task.
Do not solve the task. Judge only whether the agent's recent actions serve it.

## Agent
${agent}

## Original task (verbatim)
${task}
${scopeBlock}${hubOwnedBlock}
## Escalation signal
Rule "${violation?.rule || "unknown"}" fired: ${violation?.detail || "(no detail)"}
${advisoryBlock}

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
