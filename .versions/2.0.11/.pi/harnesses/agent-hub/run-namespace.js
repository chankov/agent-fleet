// Immutable per-run artifact namespaces — the pure policy core behind "a run's
// artifacts are never overwritten by the next run".
//
// The observed failure: `.pi/agent-sessions/artifacts/` was deleted at session
// start, and specialist returns were named by a per-session counter
// (`returns/builder-run1.md`). Two consequences, both hit at once: a later
// session's `builder-run1.md` occupied the same path as an earlier one, and the
// start-of-session wipe removed eleven implementation returns and two review
// artifacts that a post-mortem then had to record as NOT RECOVERABLE.
//
// The fix is not retention-by-luck: each session archives the previous session's
// artifacts into `runs/<runId>/`, a namespace that is written once and never
// reused, and records it in `runs/index.json`. Pruning is explicit and bounded,
// so the directory cannot grow without limit either.

export const DEFAULT_RUN_HISTORY_KEEP = 10;
export const RUNS_DIRNAME = "runs";
export const RUN_INDEX_FILENAME = "index.json";

/**
 * Run id: sortable UTC timestamp + a short random suffix, so two sessions
 * starting in the same second still get distinct namespaces.
 * `2026-08-03T09-10-42-a3f9`
 */
export function makeRunId(date = new Date(), suffix = null) {
	const iso = new Date(date).toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
	const tail = suffix ?? Math.random().toString(36).slice(2, 6);
	return `${iso}-${tail}`;
}

/** A run id we generated (used to filter stray directories out of `runs/`). */
export function isRunId(name) {
	return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9]{2,8}$/.test(String(name || ""));
}

/**
 * Which run directories to delete so at most `keep` survive.
 * Run ids sort lexicographically by time, so newest = last. `keep: null`
 * ("off") prunes nothing; non-run-id entries are never touched.
 */
export function pruneRunDirs(names, keep = DEFAULT_RUN_HISTORY_KEEP) {
	if (keep == null) return [];
	const runs = (names || []).filter(isRunId).sort();
	const limit = Math.max(0, keep);
	if (runs.length <= limit) return [];
	return runs.slice(0, runs.length - limit);
}

/**
 * The metadata written once into `runs/<runId>/meta.json`. Carries the
 * identifiers a post-mortem needs and could not previously recover: which
 * workspace/project/repo the run belonged to, and when it started and ended.
 */
export function buildRunMeta({ runId, startedAt = null, archivedAt = Date.now(), cwd = null, project = null, workspace = null, artifactCounts = null }) {
	return {
		runId,
		startedAt: startedAt == null ? null : new Date(startedAt).toISOString(),
		archivedAt: new Date(archivedAt).toISOString(),
		cwd,
		project,
		workspace,
		artifactCounts,
		note: "Immutable archive of one agent-hub session's artifacts. Written once; never rewritten.",
	};
}

/**
 * Fold a run entry into `runs/index.json`, newest last, capped at `keep`.
 * Re-indexing the same runId replaces its entry rather than duplicating it.
 */
export function appendRunIndex(existing, entry, keep = DEFAULT_RUN_HISTORY_KEEP) {
	const runs = Array.isArray(existing?.runs) ? existing.runs.filter((r) => r && r.runId !== entry.runId) : [];
	runs.push(entry);
	runs.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
	const trimmed = keep == null ? runs : runs.slice(Math.max(0, runs.length - Math.max(0, keep)));
	return { version: 1, updatedAt: new Date().toISOString(), runs: trimmed };
}

/** Parse the `run-history-keep:` overrides value → number, null ("off"), or undefined. */
export function normalizeRunHistoryKeep(value) {
	const raw = String(value ?? "").trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "off" || raw === "none" || raw === "0") return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return undefined;
	return Math.floor(n);
}
