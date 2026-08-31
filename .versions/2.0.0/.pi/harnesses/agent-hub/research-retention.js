// Retention policy for finished research helpers. The hub keeps every helper's
// card (and resumable session) in memory until something removes it; this module
// decides which finished helpers to drop so the research row doesn't grow without
// bound over a long session. Pure — the hub owns the actual state map, session
// files, and widget refresh.

export const DEFAULT_RESEARCH_KEEP = 4;

// Parse the `research-keep` override value: "all" disables pruning of durable
// helpers, a non-negative integer keeps that many most-recently-finished ones.
// Returns null for anything else (caller warns and keeps the default).
export function parseResearchKeep(value) {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "all") return Infinity;
	if (/^\d+$/.test(v)) return Number(v);
	return null;
}

// Decide which helper ids to drop. `states`: [{ id, status, finishedAt, ephemeral }].
// Running helpers are never dropped. Finished ephemeral helpers (auto-research
// pipe spawns — their findings persist as files under findings/ and their handles
// are never resumed) are always dropped. Finished durable helpers beyond the
// `keep` most recently finished are dropped, oldest first.
export function selectResearchPrunable(states, keep) {
	const capped = keep >= 0 ? keep : DEFAULT_RESEARCH_KEEP;
	const finished = (states || []).filter((s) => s.status !== "running");
	const ephemeral = finished.filter((s) => s.ephemeral).map((s) => s.id);
	const durable = finished
		.filter((s) => !s.ephemeral)
		.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
	// slice(Infinity) → [] — "all" keeps every durable helper.
	const overflow = durable.slice(capped).map((s) => s.id);
	return [...ephemeral, ...overflow];
}
