import { checkScope } from "./scope-gate.js";

/**
 * Who authored a registered task file or ran a review (plan task 5). One of:
 * - `operator`: the Hub operator's own current-state edit;
 * - `native:<canonical [workspace, instance]>`: a native instance such as editor--p2;
 * - `coms:<JSON [peer address, registry session]>`: a coms peer session. An unknown
 *   address is "*" and an unknown session null; both fail closed when compared.
 */
export const OPERATOR_AUTHOR = "operator";
export const nativeAuthor = (executor: string): string => `native:${executor}`;
export function comsAuthor(peer: { address?: string | null; sessionId?: string | null } | null | undefined): string {
	const address = typeof peer?.address === "string" && peer.address.trim() ? peer.address.trim().toLowerCase() : "*";
	const session = typeof peer?.sessionId === "string" && peer.sessionId.trim() ? peer.sessionId.trim() : null;
	return `coms:${JSON.stringify([address, session])}`;
}

function comsParts(value: string): { address: string; session: string | null } | null {
	if (!value.startsWith("coms:")) return null;
	try {
		const parsed = JSON.parse(value.slice(5));
		if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && parsed[0]
			&& (parsed[1] === null || typeof parsed[1] === "string" && parsed[1])) return { address: parsed[0], session: parsed[1] };
	} catch { /* not a coms identity */ }
	return null;
}

export function isChangeAuthor(value: unknown): value is string {
	if (typeof value !== "string" || !value || value.length > 4096) return false;
	if (value === OPERATOR_AUTHOR) return true;
	if (value.startsWith("native:")) return value.length > "native:".length;
	return comsParts(value) !== null;
}

/** The same executor. A coms identity with an unknown address or session matches
 * every session it could be, so an unattributable route can never prove independence. */
export function sameChangeAuthor(a: string, b: string): boolean {
	if (a === b) return true;
	const x = comsParts(a), y = comsParts(b);
	if (!x || !y) return false;
	if (x.address === "*" || y.address === "*") return true;
	return x.address === y.address && (x.session === null || y.session === null || x.session === y.session);
}

export function describeChangeAuthor(value: string): string {
	if (value === OPERATOR_AUTHOR) return "the operator";
	const coms = comsParts(value);
	if (coms) return `coms peer ${coms.address === "*" ? "(unknown address)" : coms.address} (session ${coms.session ?? "unknown"})`;
	try { const parsed = JSON.parse(value.slice("native:".length)); if (Array.isArray(parsed) && typeof parsed[1] === "string") return `native instance ${parsed[1]}`; } catch { /* fall through */ }
	return value;
}

/**
 * The files in a review's scope that its executor authored. The author of reviewed
 * work cannot approve it, including after changing role (the same coms peer session
 * first as editor, then as reviewer).
 */
export function selfAuthoredPaths(authors: Readonly<Record<string, readonly string[]>> | undefined, reviewer: string, scope: readonly string[]): string[] {
	if (!authors) return [];
	const authored = Object.entries(authors).filter(([, ids]) => ids.some(id => sameChangeAuthor(id, reviewer))).map(([path]) => path);
	return authored.length ? checkScope(authored, [...scope]).inScope : [];
}

export interface ReviewClosureInput {
	revision: string;
	scope: string[];
	prose?: string;
	origin?: "declared" | "extracted" | "missing";
	structuredReturn?: { verdict?: string; evidenceRefs?: string[] };
	evidenceComplete?: boolean;
	evidenceRevision?: string;
	changedAfterReview?: string[];
	status?: "closed" | "unproven" | "invalidated";
}

export interface ReviewClosure {
	status: "closed" | "unproven" | "invalidated";
	revision: string;
	scope: string[];
}

export function closeReview(input: ReviewClosureInput): ReviewClosure {
	const scope = [...input.scope];
	if (input.changedAfterReview?.some(path => scope.includes(path))) {
		return { status: "invalidated", revision: input.revision, scope };
	}
	const refs = input.structuredReturn?.evidenceRefs ?? [];
	const declared = input.origin === "declared" && input.structuredReturn?.verdict === "PASS" && refs.length > 0;
	const extracted = input.origin === "extracted" && input.structuredReturn?.verdict === "PASS" && input.evidenceComplete === true && input.evidenceRevision === input.revision && refs.length > 0;
	return { status: declared || extracted ? "closed" : "unproven", revision: input.revision, scope };
}

export function updateAssertion(input: {
	id: string;
	evidenceRef: string;
	evidenceRevision: string;
	currentRevision: string;
	changedPaths: string[];
	assertionPaths: string[];
}): { accepted: boolean; reason: string } {
	if (!input.evidenceRef.trim()) return { accepted: false, reason: "named evidence is required" };
	if (input.evidenceRevision !== input.currentRevision) return { accepted: false, reason: "evidence revision is stale" };
	const touched = input.changedPaths.some(path => input.assertionPaths.includes(path));
	if (touched) return { accepted: false, reason: "reviewed assertion path changed" };
	return { accepted: true, reason: "unrelated assertion remains valid" };
}
