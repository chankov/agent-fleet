const STRUCTURED_KEYS = [
	"changed_files",
	"assertions_proven",
	"assertions_unproven",
	"assertions_failed",
	"tests_run",
	"open_risks",
	"requires_user_decision",
];

const ASSERTION_KEYS = new Set(["assertions_proven", "assertions_unproven", "assertions_failed"]);

// Line-form verdicts. Specialists routinely report
//   ASSERTION A1: PASS — Conventional Hermes plan path ... are present
//   - **A2: FAIL** — the gate never fires
// instead of the declared schema, and the parser used to see none of it: 16 of 46
// dispatches in one session were scored "no structured return" and every assertion
// treated as unproven, including runs that had reported a complete verdict.
//
// The status must be the whole token right after the id, and any explanation must
// be introduced by a separator — so ordinary prose mentioning an id never matches.
const LINE_FORM_STATUS = {
	pass: "assertions_proven",
	passed: "assertions_proven",
	proven: "assertions_proven",
	fail: "assertions_failed",
	failed: "assertions_failed",
	blocked: "assertions_failed",
	unproven: "assertions_unproven",
	unverified: "assertions_unproven",
};

const LINE_FORM_RE =
	/^\s*(?:[-*]\s+|\d+[.)]\s+)?\**(?:ASSERTION\s+)?(A\d+)\**\s*[:\-–—]\s*\**(PASS|PASSED|PROVEN|FAIL|FAILED|BLOCKED|UNPROVEN|UNVERIFIED)\**\s*(?:[:\-–—]\s*(.*))?$/i;

export function extractAssertionIds(taskText) {
	const ids = [];
	const seen = new Set();
	for (const match of String(taskText || "").matchAll(/\bA\d+\b/g)) {
		const id = match[0];
		if (!seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

export function parseStructuredReturn(finalText) {
	const text = String(finalText || "");
	const candidates = fencedBlocks(text);
	candidates.push(text);

	let best = null;
	for (const candidate of candidates) {
		const parsed = parseCandidate(candidate);
		if (parsed && (!best || parsed.__score > best.__score)) best = parsed;
	}
	if (!best) return null;
	delete best.__score;
	return best;
}

/** Decide whether output is a return, a failure diagnostic, or still pending. */
export function deliveryDisposition(exitCode, pending = false) {
	if (pending) return { delivered: false, pending: true, status: "pending", artifactKind: null };
	if (exitCode === 0) return { delivered: true, pending: false, status: "done", artifactKind: "returns" };
	return { delivered: false, pending: false, status: "error", artifactKind: "failures" };
}

/**
 * Parse only a successfully delivered specialist result. A failed process may
 * have emitted a partial structured block before crashing, but that output is
 * diagnostic data, never assertion evidence.
 */
export function parseDeliveredReturn(finalText, dispatchedIds, delivered) {
	const parsed = delivered ? parseStructuredReturn(finalText) : null;
	return { parsed, notices: crossCheck(parsed, dispatchedIds) };
}

export function crossCheck(parsed, dispatchedIds) {
	const ids = Array.from(new Set(dispatchedIds || []));
	if (!parsed) {
		return ids.length > 0 ? [{ type: "no_structured_return", ids }] : [];
	}

	const notices = [];
	const present = new Set();
	for (const key of ["assertions_proven", "assertions_unproven", "assertions_failed"]) {
		for (const entry of parsed[key] || []) {
			if (entry && entry.id) present.add(entry.id);
		}
	}
	for (const id of ids) {
		if (!present.has(id)) notices.push({ type: "missing", id });
	}
	for (const entry of parsed.assertions_proven || []) {
		if (entry && entry.id && !entry.evidence) {
			notices.push({ type: "proven_without_evidence", id: entry.id, note: entry.note || "" });
		}
	}
	return notices;
}

function fencedBlocks(text) {
	const blocks = [];
	const re = /```[^\n]*\n([\s\S]*?)```/g;
	let match;
	while ((match = re.exec(text))) blocks.push(match[1]);
	return blocks;
}

function parseCandidate(text) {
	const result = Object.fromEntries(STRUCTURED_KEYS.map((key) => [key, []]));
	let score = 0;

	const keyBlocks = collectKeyBlocks(text);
	for (const [key, block] of keyBlocks) {
		result[key] = parseEntries(key, block);
		score += 2 + result[key].length;
	}

	const sectionBlocks = collectMarkdownSections(text);
	for (const [key, block] of sectionBlocks) {
		if (!keyBlocks.has(key)) {
			result[key] = parseEntries(key, block);
			score += 1 + result[key].length;
		}
	}

	// Lowest-precedence source: a specialist that follows the schema is never
	// second-guessed. A declared bucket wins outright, and an id the schema already
	// classified is never re-stated from a loose line — otherwise a stale summary
	// line could land the same id in two buckets at once.
	const declaredIds = new Set();
	for (const key of ASSERTION_KEYS) {
		for (const entry of result[key] || []) {
			if (entry && entry.id) declaredIds.add(entry.id);
		}
	}
	for (const [key, entries] of collectLineFormAssertions(text)) {
		if (keyBlocks.has(key) || sectionBlocks.has(key)) continue;
		const fresh = entries.filter((entry) => !declaredIds.has(entry.id));
		if (fresh.length === 0) continue;
		result[key] = fresh;
		score += fresh.length;
	}

	if (score === 0) return null;
	result.__score = score;
	return result;
}

function collectKeyBlocks(text) {
	const found = new Map();
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^\s*([A-Za-z][A-Za-z0-9_ -]*)\s*:\s*(.*)$/);
		if (!match) continue;
		const key = normalizeKey(match[1]);
		if (!STRUCTURED_KEYS.includes(key)) continue;

		const block = [match[2] || ""];
		let bracketBalance = balanceBrackets(match[2] || "");
		let j = i + 1;
		for (; j < lines.length; j++) {
			const next = lines[j];
			const nextKey = next.match(/^\s*([A-Za-z][A-Za-z0-9_ -]*)\s*:\s*/);
			const isKnownNextKey = nextKey && STRUCTURED_KEYS.includes(normalizeKey(nextKey[1]));
			const isHeading = /^\s*#{1,6}\s+/.test(next);
			if (bracketBalance <= 0 && (isKnownNextKey || isHeading)) break;
			if (next.trim() === "" && bracketBalance <= 0) break;
			block.push(next);
			bracketBalance += balanceBrackets(next);
		}
		found.set(key, block.join("\n"));
	}
	return found;
}

function collectMarkdownSections(text) {
	const found = new Map();
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
		if (!match) continue;
		const key = normalizeKey(match[1]);
		if (!STRUCTURED_KEYS.includes(key)) continue;
		const block = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (/^\s*#{1,6}\s+/.test(lines[j])) break;
			block.push(lines[j]);
		}
		found.set(key, block.join("\n"));
	}
	return found;
}

function collectLineFormAssertions(text) {
	const found = new Map();
	const seen = new Set();
	for (const line of String(text || "").split(/\r?\n/)) {
		const match = line.match(LINE_FORM_RE);
		if (!match) continue;
		const id = match[1].toUpperCase();
		const key = LINE_FORM_STATUS[match[2].toLowerCase()];
		// First verdict per id wins: a later restatement is a summary, not a change.
		if (!key || seen.has(id)) continue;
		seen.add(id);
		// The text after the separator IS the named evidence in this form. Left null
		// for a bare verdict, so crossCheck still demotes it to unproven.
		const evidence = String(match[3] || "").trim().replace(/\*+$/, "").trim() || null;
		if (!found.has(key)) found.set(key, []);
		found.get(key).push({ id, note: "", evidence });
	}
	return found;
}

function parseEntries(key, rawBlock) {
	if (ASSERTION_KEYS.has(key)) {
		return splitAssertionEntries(rawBlock).map(parseAssertionEntry).filter(Boolean);
	}
	return splitListEntries(rawBlock);
}

function normalizeListBlock(rawBlock) {
	let block = String(rawBlock || "").trim();
	if (!block || block === "[]") return "";
	if (block.startsWith("[") && block.endsWith("]")) block = block.slice(1, -1);
	return block;
}

function strippedLines(block) {
	return block.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/,$/, "").trim())
		.filter(Boolean);
}

function splitListEntries(rawBlock) {
	const block = normalizeListBlock(rawBlock);
	if (!block) return [];
	const rawLines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const hasBulletLines = rawLines.some((line) => /^([-*]|\d+[.)])\s+/.test(line));
	if (hasBulletLines) return strippedLines(block);
	return [block.trim()];
}

function splitAssertionEntries(rawBlock) {
	const block = normalizeListBlock(rawBlock);
	if (!block) return [];
	const rawLines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const hasBoundaryLines = rawLines.some((line) => /^([-*]|\d+[.)])\s+\bA\d+\b/.test(line));
	if (hasBoundaryLines) return strippedLines(block).filter((line) => /^\bA\d+\b/.test(line));
	return block
		.split(/,(?=\s*A\d+\s*[:\-–—])/g)
		.map((part) => part.trim().replace(/^,+\s*/, "").replace(/,+\s*$/, ""))
		.filter(Boolean);
}

function parseAssertionEntry(entry) {
	const text = String(entry || "").trim();
	const idMatch = text.match(/\bA\d+\b/);
	if (!idMatch) return null;
	const id = idMatch[0];
	let rest = text.slice((idMatch.index || 0) + id.length).trim();
	rest = rest.replace(/^[:\-–—]\s*/, "");

	let evidence = null;
	const evidenceMatch = rest.match(/(?:^|\s+[—–-]\s*|\s+)evidence\s*:\s*([\s\S]*)$/i);
	if (evidenceMatch) {
		evidence = evidenceMatch[1].trim() || null;
		rest = rest.slice(0, evidenceMatch.index).trim();
	}
	const note = rest.replace(/[✓✔]\s*$/u, "").trim();
	return { id, note, evidence };
}

function normalizeKey(value) {
	return String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[`*]/g, "")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function balanceBrackets(value) {
	const opens = (String(value).match(/\[/g) || []).length;
	const closes = (String(value).match(/\]/g) || []).length;
	return opens - closes;
}
