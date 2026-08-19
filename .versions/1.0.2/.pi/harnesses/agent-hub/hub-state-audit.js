// Pure, allowlisted serializers for Hub mode/task lifecycle audit entries.
// Callers provide only runtime identity fields; unknown properties are ignored.

function text(value, max = 4096) {
	if (typeof value !== "string") return null;
	const clean = value.replace(/[\r\n]+/g, " ").trim();
	return clean ? clean.slice(0, max) : null;
}

function count(value) {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Return only non-secret process/session routing identity. */
export function buildHubAuditIdentity(input = {}) {
	return {
		cwd: text(input.cwd),
		pid: count(input.pid),
		session_id: text(input.sessionId, 256),
		project: text(input.project, 256),
		herdr_workspace_id: text(input.workspaceId, 256),
		herdr_pane_id: text(input.paneId, 256),
	};
}

export function buildHubModeAudit(input = {}) {
	return {
		schema_version: 1,
		previous_mode: text(input.previousMode, 32),
		mode: text(input.mode, 32),
		source: text(input.source, 64),
		override_file: text(input.overrideFile),
		task_tier: text(input.taskTier, 32),
		turn_dispatches: count(input.turnDispatches),
		turn_research: count(input.turnResearch),
		identity: buildHubAuditIdentity(input.identity),
	};
}

export function buildTaskResetAudit(input = {}) {
	const prior = input.prior ?? {};
	return {
		schema_version: 1,
		source: text(input.source, 64),
		label: text(input.label, 160),
		prior: {
			tier: text(prior.tier, 32),
			dispatches: count(prior.dispatches),
			research: count(prior.research),
			review_rounds: count(prior.reviewRounds),
			active_ms: count(prior.activeMs),
		},
		identity: buildHubAuditIdentity(input.identity),
	};
}

export function buildBudgetContinuationAudit(input = {}) {
	const prior = input.prior ?? {};
	return {
		schema_version: 1,
		kind: text(input.kind, 16),
		continuation: count(input.continuation),
		reason: text(input.reason, 64),
		prior: {
			tier: text(prior.tier, 32),
			dispatches: count(prior.dispatches),
			research: count(prior.research),
			review_rounds: count(prior.reviewRounds),
			active_ms: count(prior.activeMs),
		},
		identity: buildHubAuditIdentity(input.identity),
	};
}
