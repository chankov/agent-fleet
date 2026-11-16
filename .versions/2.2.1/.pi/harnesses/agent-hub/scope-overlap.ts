/**
 * Conservative overlap test for declared write scopes. Two concurrent writers may
 * run only when this proves their scopes disjoint; anything it cannot prove
 * disjoint counts as overlapping (PHILOSOPHY, 2026-11-11: parallel writes need
 * runtime-enforced non-overlapping scopes).
 *
 * A scope entry is a repository-relative path or glob. The literal prefix before
 * the first glob character is its anchor: `src/a/**` anchors at `src/a`, `src/*.ts`
 * at `src`, `**` at the root. Two entries overlap when one anchor contains the
 * other (or they are equal). This over-approximates — `src/*.ts` and `src/b/x.ts`
 * are reported as overlapping even though a single-segment glob cannot match the
 * nested file — which only costs parallelism, never attribution.
 */

const GLOB = /[*?[\]{}!]/;

export function normalizeScopeEntry(entry: string): string {
	return String(entry ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Path segments of the literal anchor; [] means the repository root (overlaps everything). */
export function scopeAnchor(entry: string): string[] {
	const normalized = normalizeScopeEntry(entry);
	const segments = normalized ? normalized.split("/") : [];
	const anchor: string[] = [];
	for (const segment of segments) {
		if (GLOB.test(segment) || segment === "" || segment === ".") break;
		if (segment === "..") return [];
		anchor.push(segment);
	}
	return anchor;
}

const contains = (outer: string[], inner: string[]) => outer.length <= inner.length && outer.every((part, i) => part === inner[i]);

export function entriesOverlap(a: string, b: string): boolean {
	const left = scopeAnchor(a), right = scopeAnchor(b);
	return contains(left, right) || contains(right, left);
}

/** First overlapping pair, or null when the scopes are provably disjoint. An empty scope overlaps everything. */
export function findScopeOverlap(a: readonly string[], b: readonly string[]): { left: string; right: string } | null {
	if (!a.length || !b.length) return { left: a[0] ?? "(whole repository)", right: b[0] ?? "(whole repository)" };
	for (const left of a) for (const right of b) if (entriesOverlap(left, right)) return { left, right };
	return null;
}
