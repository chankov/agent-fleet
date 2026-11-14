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
