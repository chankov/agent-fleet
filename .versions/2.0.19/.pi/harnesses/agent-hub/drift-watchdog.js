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

/** Specialist tool kinds that may appear in structured observations. Anything else is `other`. */
export const WATCHDOG_TOOL_KINDS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const WATCHDOG_TOOL_KIND_SET = new Set(WATCHDOG_TOOL_KINDS);
/** Calibrated structured window. Legacy `trailLimit` is a separate judge-text bound. */
export const WATCHDOG_STRUCTURED_EVENT_LIMIT = 40;

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
	const groupIds = new Map();
	const groupCounts = new Map();
	const structuredEvents = [];
	let nextGroup = 1;
	let totalCalls = 0;
	let consecutiveFailures = 0;
	let failureCount = 0;
	let eventsSeen = 0;
	let droppedByWindow = 0;
	let droppedIncomplete = 0;
	let unparsedEvents = 0;

	const pushTrail = (line) => {
		trailLines.push(line);
		if (trailLines.length > trailLimit) trailLines.shift();
	};

	const pushStructured = (event) => {
		structuredEvents.push(event);
		while (structuredEvents.length > WATCHDOG_STRUCTURED_EVENT_LIMIT) {
			const dropped = structuredEvents.shift();
			if (dropped?.open) droppedIncomplete++;
			else droppedByWindow++;
		}
	};

	const noteStructuredStart = (toolName, argStr, callId) => {
		if (typeof toolName !== "string" || (argStr != null && typeof argStr !== "string")) {
			eventsSeen++;
			unparsedEvents++;
			return;
		}
		const fingerprint = `${toolName}::${argStr || ""}`;
		let group = groupIds.get(fingerprint);
		if (!group) {
			group = nextGroup++;
			groupIds.set(fingerprint, group);
		}
		const repeat = (groupCounts.get(fingerprint) || 0) + 1;
		groupCounts.set(fingerprint, repeat);
		eventsSeen++;
		const event = {
			tool: WATCHDOG_TOOL_KIND_SET.has(toolName) ? toolName : "other",
			outcome: "unknown",
			repeat_group: group,
			repeat_count: repeat,
			open: true,
		};
		if (callId != null && callId !== "") event.callId = String(callId);
		const path = pathFromArgs(argStr);
		if (path) event.path = path;
		pushStructured(event);
	};

	const closeStructured = (toolName, outcome, callId) => {
		if (typeof toolName !== "string") {
			unparsedEvents++;
			return;
		}
		const kind = WATCHDOG_TOOL_KIND_SET.has(toolName) ? toolName : "other";
		const close = (event) => {
			event.outcome = outcome;
			event.open = false;
		};
		if (callId != null && callId !== "") {
			const id = String(callId);
			const matches = structuredEvents.filter((event) => event.open && event.callId === id);
			// Duplicate or mismatched ids are ambiguous — do not attach this end to another call.
			if (matches.length !== 1 || matches[0].tool !== kind) {
				unparsedEvents++;
				return;
			}
			close(matches[0]);
			return;
		}
		// No id: only an unambiguous unkeyed open of this kind. Never steal a callId-tracked event.
		const unkeyed = structuredEvents.filter((event) => event.open && event.tool === kind && (event.callId == null || event.callId === ""));
		if (unkeyed.length !== 1) {
			unparsedEvents++;
			return;
		}
		close(unkeyed[0]);
	};

	let lastScopeViolation = null;
	let lastLoopViolation = null;
	return {
		isSignalCurrent(violation) {
			switch (violation?.rule) {
				case "scope": return lastScopeViolation === violation.detail;
				case "loop": return lastLoopViolation === violation.detail;
				case "toolcap": return totalCalls >= maxToolCalls;
				case "failures": return consecutiveFailures >= maxConsecutiveFailures;
				default: return false;
			}
		},
		onToolStart(toolName, argStr, callId) {
			totalCalls++;
			pushTrail(`${toolName} ${String(argStr || "").slice(0, 120)}`.trim());
			noteStructuredStart(toolName, argStr, callId);

			lastScopeViolation = null;
			if (scopeGlobs.length > 0 && writeTools.has(toolName)) {
				const path = pathFromArgs(argStr);
				if (path && checkScope([path], effectiveScope).outOfScope.length > 0) {
					lastScopeViolation = `${toolName} touched ${path} — outside the declared scope (${scopeGlobs.join(", ")})`;
					return { rule: "scope", terminal: false, detail: lastScopeViolation };
				}
			}

			const fingerprint = `${toolName}::${argStr || ""}`;
			const count = (callCounts.get(fingerprint) || 0) + 1;
			callCounts.set(fingerprint, count);
			if (count === maxRepeats) {
				lastLoopViolation = `${toolName} called ${count}× with identical arguments — likely stuck in a loop`;
				return { rule: "loop", terminal: true, detail: lastLoopViolation };
			}

			if (totalCalls === maxToolCalls) {
				return { rule: "toolcap", terminal: true, detail: `${totalCalls} tool calls in one run — far beyond a focused task` };
			}
			return null;
		},

		onToolEnd(toolName, isError, callId) {
			if (isError === true) {
				consecutiveFailures++;
				failureCount++;
				pushTrail("  ↳ FAILED");
				closeStructured(toolName, "error", callId);
				if (consecutiveFailures % maxConsecutiveFailures === 0) {
					return { rule: "failures", terminal: true, detail: `${consecutiveFailures} consecutive failed tool calls — no forward progress` };
				}
			} else if (isError === false) {
				consecutiveFailures = 0;
				closeStructured(toolName, "success", callId);
			} else {
				// Missing error flag is incomplete, not success, and must not stay open for a later end.
				closeStructured(toolName, "unknown", callId);
			}
			return null;
		},

		trail(n = 40) {
			return trailLines.slice(-n);
		},

		/**
		 * Structured observation for watchdog-state/v1. Not the legacy trail and not
		 * the outbound payload: no raw arguments, command text, write bodies, or detail.
		 * Repeat groups are local integers; the fingerprint map stays in this closure.
		 */
		structuredObservation() {
			return {
				events: structuredEvents.map((event) => {
					const publicEvent = {
						tool: event.tool,
						outcome: event.open ? "unknown" : event.outcome,
						repeat_group: event.repeat_group,
						repeat_count: event.repeat_count,
					};
					if (event.path) publicEvent.path = event.path;
					return publicEvent;
				}),
				counters: {
					tool_calls: totalCalls,
					failures: failureCount,
					consecutive_failures: consecutiveFailures,
				},
				coverage: {
					events_seen: eventsSeen,
					dropped_by_window: droppedByWindow,
					dropped_incomplete: droppedIncomplete,
					unparsed_events: unparsedEvents,
					missing_tool_end: structuredEvents.filter((event) => event.open).length,
				},
			};
		},
	};
}

/**
 * The one-shot judge prompt: original task + declared scope + recent trail +
 * the rule that fired. The judge answers with a single machine-parseable line.
 * @param {{agent: string, task: string, scopeGlobs?: string[], hubOwnedGlobs?: string[], trail?: string[], violation?: {rule: string, detail: string, terminal?: boolean}}} input
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
