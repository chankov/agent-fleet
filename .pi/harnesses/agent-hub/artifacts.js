import { isAbsolute, relative, resolve, sep } from "node:path";

// `failures` is deliberately its own kind, not a flavour of `returns`: a run
// that errored or timed out produced no specialist result, and storing its error
// text as a return is the most expensive artifact in the system — a 142-byte
// coms error stub written to returns/code-reviewer-run4.md cost a full dispatch
// investigating a review that had in fact succeeded, only its reply was lost.
export const ARTIFACT_KINDS = ["returns", "failures", "plans", "reviews", "inventories", "evidence"];

const SESSION_RELATIVE_PREFIXES = new Set(["artifacts", "findings", "delegations"]);
const PREVIEW_LIMIT = 180;

export function resolveArtifactPath(inputPath, options) {
	const raw = String(inputPath || "").trim();
	if (!raw) throw new Error("Artifact path must be a non-empty string");
	if (/\0/.test(raw)) throw new Error(`Invalid artifact path ${JSON.stringify(raw)}`);

	const repoDir = resolve(options.repoDir);
	const sessionDir = resolve(options.sessionDir);
	const artifactRoot = options.artifactRoot ? resolve(options.artifactRoot) : resolve(sessionDir, "artifacts");
	const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");

	const candidates = [];
	if (isAbsolute(raw)) {
		const absoluteTarget = resolve(raw);
		if (isWithin(artifactRoot, absoluteTarget)) {
			candidates.push({ root: artifactRoot, target: absoluteTarget, displayBase: artifactRoot, prefix: "artifacts" });
		} else if (isWithin(sessionDir, absoluteTarget)) {
			candidates.push({ root: sessionDir, target: absoluteTarget, displayBase: sessionDir, prefix: ".pi/agent-sessions" });
		}
		candidates.push({ root: repoDir, target: absoluteTarget, displayBase: repoDir, prefix: "" });
	} else {
		const first = normalized.split("/")[0];
		if (first === "artifacts") {
			candidates.push({ root: sessionDir, target: safeJoin(sessionDir, normalized), displayBase: artifactRoot, prefix: "artifacts" });
		} else if (ARTIFACT_KINDS.includes(first)) {
			candidates.push({ root: artifactRoot, target: safeJoin(artifactRoot, normalized), displayBase: artifactRoot, prefix: "artifacts" });
			candidates.push({ root: repoDir, target: safeJoin(repoDir, normalized), displayBase: repoDir, prefix: "" });
		} else if (SESSION_RELATIVE_PREFIXES.has(first)) {
			candidates.push({ root: sessionDir, target: safeJoin(sessionDir, normalized), displayBase: sessionDir, prefix: ".pi/agent-sessions" });
		} else {
			candidates.push({ root: repoDir, target: safeJoin(repoDir, normalized), displayBase: repoDir, prefix: "" });
		}
	}

	const valid = candidates.filter((candidate) => isWithin(candidate.root, candidate.target));
	if (valid.length === 0) {
		throw new Error(`Refusing artifact path outside repo/session: ${raw}`);
	}

	const exists = typeof options.exists === "function" ? options.exists : () => true;
	const found = valid.find((candidate) => exists(candidate.target));
	if (found) {
		return {
			input: raw,
			path: found.target,
			displayPath: displayPath(found.target, found.displayBase, found.prefix),
			resolvedFromKind: null,
		};
	}

	// Nothing at the requested path. The hub writes EVERY auto-return under
	// `returns/`, while the deliverable protocol teaches dispatchers that documents
	// live in `artifacts/<kind>/` — so `reviews/code-reviewer-run1.md` is the
	// natural and wrong guess for a file that is sitting in `returns/`. Look for
	// the same name under the other kinds instead of reporting a missing file.
	const requested = matchKindPath(normalized);
	if (requested) {
		const hits = ARTIFACT_KINDS
			.filter((kind) => kind !== requested.kind)
			.map((kind) => ({ kind, target: resolve(artifactRoot, `${kind}/${requested.rest}`) }))
			.filter((candidate) => isWithin(artifactRoot, candidate.target) && exists(candidate.target));
		if (hits.length === 1) {
			return {
				input: raw,
				path: hits[0].target,
				displayPath: displayPath(hits[0].target, artifactRoot, "artifacts"),
				resolvedFromKind: hits[0].kind,
			};
		}
		// Never guess between kinds: two files with the same name are two documents.
		if (hits.length > 1) {
			throw new Error(
				`Ambiguous artifact ${raw}: "${requested.rest}" exists under ${hits.map((h) => `${h.kind}/`).join(" and ")}. ` +
				"Name the kind explicitly.",
			);
		}
	}

	const picked = valid[0];
	return {
		input: raw,
		path: picked.target,
		displayPath: displayPath(picked.target, picked.displayBase, picked.prefix),
		resolvedFromKind: null,
	};
}

/** `reviews/x.md` / `artifacts/reviews/x.md` → `{ kind: "reviews", rest: "x.md" }`. */
function matchKindPath(normalized) {
	const parts = String(normalized || "").split("/").filter(Boolean);
	const offset = parts[0] === "artifacts" ? 1 : 0;
	const kind = parts[offset];
	if (!ARTIFACT_KINDS.includes(kind)) return null;
	const rest = parts.slice(offset + 1).join("/");
	return rest ? { kind, rest } : null;
}

export function resolveArtifactPaths(paths, options) {
	return (paths || []).map((p) => resolveArtifactPath(p, options));
}

export function artifactPreviewFromText(text) {
	const lines = String(text || "").split(/\r?\n/);
	const heading = lines.map((line) => line.trim()).find((line) => /^#{1,6}\s+\S/.test(line));
	if (heading) return truncate(heading.replace(/^#{1,6}\s+/, ""));
	const first = lines.map((line) => line.trim()).find(Boolean);
	return first ? truncate(first) : "(empty file)";
}

export function formatInputArtifactsSection(items) {
	if (!items || items.length === 0) return "";
	const lines = items.map((item) => `- ${item.displayPath || item.path} — ${item.preview || "(no preview)"}`);
	return `\n\n## Input artifacts\nRead these files with your own read tool when needed. The dispatcher is passing paths plus a one-line preview only; file bodies are intentionally not inlined.\n${lines.join("\n")}`;
}

function safeJoin(root, relativePath) {
	const target = resolve(root, relativePath);
	if (!isWithin(root, target)) throw new Error(`Refusing artifact path outside repo/session: ${relativePath}`);
	return target;
}

function isWithin(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function displayPath(target, base, prefix) {
	const rel = relative(resolve(base), resolve(target)).split(sep).join("/");
	if (!prefix) return rel || ".";
	return rel ? `${prefix}/${rel}` : prefix;
}

function truncate(value) {
	return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT - 1)}…` : value;
}
