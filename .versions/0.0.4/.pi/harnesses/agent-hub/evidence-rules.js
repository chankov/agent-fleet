import { isAbsolute, relative, resolve } from "node:path";

const KNOWN_TAGS = new Set(["test", "runtime-ui", "code-grep", "manual"]);

export function validateEvidence(tag, evidence, options = {}) {
	const normalizedTag = String(tag || "").trim().toLowerCase();
	const text = String(evidence || "").trim();
	if (!KNOWN_TAGS.has(normalizedTag)) {
		return { ok: false, reason: `Unknown assertion tag "${tag}"; expected one of test, runtime-ui, code-grep, manual.` };
	}
	if (!text) return { ok: false, reason: "Evidence is required." };

	if (normalizedTag === "test") return validateTestEvidence(text);
	if (normalizedTag === "runtime-ui") return validateRuntimeUiEvidence(text, options);
	if (normalizedTag === "code-grep") return validateCodeGrepEvidence(text);
	if (normalizedTag === "manual") return validateManualEvidence(text);
	return { ok: false, reason: `Unknown assertion tag "${tag}".` };
}

function validateTestEvidence(text) {
	const hasIdentifier = /(?:\b(?:npm|pnpm|yarn|node|npx|vitest|jest|pytest|playwright|cargo|go test|bun)\b|\btest(?:s| name| file)?\b|`[^`]+`)/i.test(text);
	const hasOutcome = /(?:\bpass(?:ed|es)?\b|\bgreen\b|\bok\b|\bexit\s*0\b|\b0\s+fail(?:ed|ures)?\b|\b\d+\/\d+\b|✓|✔)/i.test(text);
	if (!hasIdentifier && !hasOutcome) return { ok: false, reason: "Test evidence must name the command/test identifier and its outcome." };
	if (!hasIdentifier) return { ok: false, reason: "Test evidence must name the command or test identifier." };
	if (!hasOutcome) return { ok: false, reason: "Test evidence must include the test outcome (pass/fail count, exit status, or equivalent)." };
	return { ok: true };
}

function validateRuntimeUiEvidence(text, options) {
	const candidates = extractPathCandidates(text).filter((p) => /(?:^|\/)artifacts\/evidence\//.test(normalizePath(p)));
	if (candidates.length === 0) {
		return { ok: false, reason: "Runtime-ui evidence must reference a session artifact path under artifacts/evidence/." };
	}
	const fileExists = typeof options.fileExists === "function" ? options.fileExists : () => false;
	const evidenceRoot = options.evidenceRoot ? resolve(options.evidenceRoot) : null;
	const resolvedCandidates = candidates.map((p) => resolveSessionEvidenceCandidate(p, evidenceRoot)).filter(Boolean);
	if (resolvedCandidates.length === 0) {
		return { ok: false, reason: "Runtime-ui evidence must reference a session artifact evidence path, not a repo-local ./artifacts path." };
	}
	const existing = resolvedCandidates.find((p) => {
		try { return fileExists(p); } catch { return false; }
	});
	if (!existing) {
		return { ok: false, reason: `Runtime-ui evidence artifact does not exist: ${resolvedCandidates[0]}.` };
	}
	return { ok: true };
}

function validateCodeGrepEvidence(text) {
	const hasPattern = /(?:\bpattern\s*:|\bregex\s*:|\bgrep\b|`[^`]+`|\/[^/]+\/)/i.test(text);
	const hasSample = /(?:\bmatch(?:ed|es)?\b|\bno[- ]?match(?:es)?\b|\b0\s+matches\b|\bfound\b|\bnot found\b|[\w./-]+:\d+)/i.test(text);
	if (!hasPattern && !hasSample) return { ok: false, reason: "Code-grep evidence must include the searched pattern and a match/no-match result sample." };
	if (!hasPattern) return { ok: false, reason: "Code-grep evidence must include the searched pattern." };
	if (!hasSample) return { ok: false, reason: "Code-grep evidence must include a match/no-match result sample." };
	return { ok: true };
}

function validateManualEvidence(text) {
	const hasConfirmation = /(?:\bask_user\b|\bhuman\s+confirm(?:ed|ation)\b|\buser\s+(?:confirmed|said|approved|chose|answered)\b|\bmanual\s+confirm(?:ed|ation)\b|"[^"]+")/i.test(text);
	if (!hasConfirmation) return { ok: false, reason: "Manual evidence must reference the ask_user answer or explicit user confirmation." };
	return { ok: true };
}

function extractPathCandidates(text) {
	const out = [];
	const re = /(?:^|[\s(\[])(["']?)([^"'\s)\]]*(?:\.pi\/agent-sessions\/)?artifacts\/evidence\/[^"'\s)\]]+)\1/g;
	let match;
	while ((match = re.exec(text))) out.push(match[2].replace(/[.,;:]+$/, ""));
	return out;
}

function resolveSessionEvidenceCandidate(candidate, evidenceRoot) {
	const raw = String(candidate || "").trim();
	const normalized = normalizePath(raw);
	if (normalized.startsWith("./artifacts/evidence/")) return null;
	if (evidenceRoot && normalized.startsWith("artifacts/evidence/")) {
		return resolve(evidenceRoot, normalized.slice("artifacts/evidence/".length));
	}
	if (evidenceRoot && normalized.startsWith(".pi/agent-sessions/artifacts/evidence/")) {
		return resolve(evidenceRoot, normalized.slice(".pi/agent-sessions/artifacts/evidence/".length));
	}
	if (isAbsolute(raw)) {
		const abs = resolve(raw);
		return !evidenceRoot || isWithin(evidenceRoot, abs) ? abs : null;
	}
	return null;
}

function isWithin(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function normalizePath(value) {
	return String(value || "").replace(/\\/g, "/");
}
