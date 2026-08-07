// Docs-only lane — the pure policy core behind "a documentation change is not a
// code change". A closeout that touched only markdown was routed through a full
// code-review gate, which produced a reviewer cycle, a stop, and an objection
// from the human; the review had no code to review. This module decides, from a
// dispatch's declared `scope` globs alone, whether the change is documentation.
//
// Everything here is data + pure functions so the policy is unit-testable away
// from the harness.

import { REVIEW_PERSONAS } from "./run-budget.js";

// Extensions that are documentation by nature.
const DOC_EXTENSIONS = new Set(["md", "mdx", "markdown", "rst", "adoc", "txt"]);

// Path prefixes whose entire subtree is documentation/evidence. Matched on the
// first segment, case-insensitively.
const DOC_DIRS = new Set(["docs", "doc", "artifacts", "adr", "adrs", "changelog", ".changeset"]);

// Extensionless files that are documentation when they sit at a scope root.
const DOC_BASENAMES = new Set(["readme", "license", "licence", "changelog", "contributing", "notice", "authors", "codeowners"]);

// Personas whose dispatch is a review GATE. test-engineer is included: asking
// for tests on a markdown change is the same category error as asking for a
// code review of it.
export const DOCS_BLOCKED_PERSONAS = [...REVIEW_PERSONAS, "test-engineer"];

/** Strip glob magic so a pattern can be judged by its literal shape. */
function literalize(glob) {
	return String(glob || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

/**
 * Is ONE glob confined to documentation?
 * `Docs/**`, `**\/*.md`, `CHANGELOG.md`, `artifacts/evidence/*.png` → true.
 * `**`, `src/**`, `**\/*.{md,ts}`, `RIN.Live/**\/*.md` → the last one is true
 * (it can only ever match markdown), the first three are false.
 */
export function isDocsGlob(glob) {
	const pattern = literalize(glob);
	if (!pattern) return false;

	const segments = pattern.split("/").filter(Boolean);
	if (segments.length === 0) return false;

	// A leading documentation directory confines everything beneath it, whatever
	// the tail looks like — `Docs/**`, `artifacts/evidence/*.png`.
	const first = segments[0].toLowerCase();
	if (DOC_DIRS.has(first) && !first.includes("*")) return true;

	// Otherwise the FINAL segment has to confine the match to a doc file: any
	// wildcard directory in between is fine, since the leaf still decides.
	const leaf = segments[segments.length - 1];
	if (!leaf || leaf === "**" || leaf === "*") return false;

	// Brace alternation is only docs when EVERY alternative is.
	const braces = leaf.match(/\{([^}]*)\}/);
	if (braces) {
		const alternatives = braces[1].split(",").map((a) => a.trim()).filter(Boolean);
		if (alternatives.length === 0) return false;
		return alternatives.every((alt) => isDocsGlob(leaf.replace(/\{[^}]*\}/, alt)));
	}

	const dot = leaf.lastIndexOf(".");
	if (dot === -1) {
		// No extension: only a known documentation basename counts, and only when
		// it carries no wildcard (`README` yes, `REA*` no).
		if (/[*?[\]]/.test(leaf)) return false;
		return DOC_BASENAMES.has(leaf.toLowerCase());
	}
	const ext = leaf.slice(dot + 1).toLowerCase();
	if (/[*?[\]]/.test(ext)) return false;
	return DOC_EXTENSIONS.has(ext);
}

/**
 * Is the whole declared scope documentation-only? An empty/absent scope is NOT
 * docs-only — an undeclared scope means "unknown", and unknown is never the
 * lighter lane.
 */
export function isDocsOnlyScope(globs) {
	const list = (globs || []).map(literalize).filter(Boolean);
	if (list.length === 0) return false;
	return list.every((glob) => isDocsGlob(glob));
}

/**
 * Gate a review-persona dispatch whose scope is documentation only.
 * Returns null when allowed, else { reason, message }. `reviewReason` is the
 * dispatcher's explicit justification and always opens the gate — a docs change
 * CAN warrant review (a published credential, a contractual API doc), it just
 * must not be the default.
 */
export function checkDocsLane(agent, scopeGlobs, reviewReason = "") {
	const name = String(agent || "").trim().toLowerCase();
	if (!DOCS_BLOCKED_PERSONAS.includes(name)) return null;
	if (!isDocsOnlyScope(scopeGlobs)) return null;
	if (String(reviewReason || "").trim()) return null;
	return {
		reason: "docs_only_lane",
		message: `⚠ ${name} refused for a documentation-only scope — and this dispatch was NOT counted ` +
			`against any budget.\nScope: ${(scopeGlobs || []).join(", ")}\n` +
			`Documentation changes run in the single-worker docs lane: the writer verifies its own change ` +
			`(links resolve, statements match the code it describes) and the work is done. A review gate here ` +
			`produces a round trip with no code to review.\n` +
			`If this docs change genuinely needs a gate — it publishes a credential or secret, it states a ` +
			`contract other systems rely on, or the human asked for a review — re-dispatch with ` +
			`\`review_reason: "<why>"\`. If the change also touches code, put those paths in \`scope\` too.`,
	};
}

/** Note appended to a non-review dispatch that runs in the docs lane. */
export function docsLaneNotice(agent, scopeGlobs) {
	if (!isDocsOnlyScope(scopeGlobs)) return null;
	const name = String(agent || "").trim().toLowerCase();
	if (DOCS_BLOCKED_PERSONAS.includes(name)) return null;
	return `📝 Docs lane: this dispatch's scope is documentation only, so it needs no review gate. ` +
		`Take ${name}'s own verification as sufficient and close the item — do not dispatch a reviewer for it.`;
}
