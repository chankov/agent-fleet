import assert from "node:assert/strict";
import test from "node:test";
import { closeReview, updateAssertion } from "./review-closure.ts";

const current = { revision: "abc123", scope: ["src/adapter.ts"] };

test("declared return closes only the current revision and scope", () => {
	const closed = closeReview({
		...current,
		prose: "PASS",
		structuredReturn: { verdict: "PASS", evidenceRefs: ["artifacts/evidence/adapter.json"] },
		origin: "declared",
	});
	assert.equal(closed.status, "closed");
	assert.equal(closed.revision, "abc123");
	assert.deepEqual(closed.scope, ["src/adapter.ts"]);
});

test("substantive PASS without a structured return stays unproven", () => {
	assert.equal(closeReview({ ...current, prose: "PASS", origin: "missing" }).status, "unproven");
});

test("extracted return closes a contract gap only when evidence is complete and current", () => {
	assert.equal(closeReview({
		...current,
		prose: "PASS",
		origin: "extracted",
		structuredReturn: { verdict: "PASS", evidenceRefs: ["artifacts/evidence/adapter.json"] },
		evidenceComplete: true,
		evidenceRevision: "abc123",
	}).status, "closed");
	assert.equal(closeReview({
		...current,
		prose: "PASS",
		origin: "extracted",
		structuredReturn: { verdict: "PASS", evidenceRefs: [] },
		evidenceComplete: false,
		evidenceRevision: "abc123",
	}).status, "unproven");
	assert.equal(closeReview({
		...current,
		prose: "PASS",
		origin: "extracted",
		structuredReturn: { verdict: "PASS", evidenceRefs: ["artifacts/evidence/adapter.json"] },
		evidenceComplete: true,
		evidenceRevision: "old",
	}).status, "unproven");
});

test("post-review mutation invalidates the reviewed file but not an unrelated assertion", () => {
	const closed = closeReview({
		...current,
		prose: "PASS",
		origin: "declared",
		structuredReturn: { verdict: "PASS", evidenceRefs: ["artifacts/evidence/adapter.json"] },
	});
	const drifted = closeReview({ ...closed, changedAfterReview: ["src/adapter.ts"] });
	assert.equal(drifted.status, "invalidated");
	const unrelated = updateAssertion({
		id: "docs-link",
		evidenceRef: "artifacts/evidence/docs.json",
		evidenceRevision: "abc123",
		currentRevision: "abc123",
		changedPaths: ["src/adapter.ts"],
		assertionPaths: ["docs/README.md"],
	});
	assert.equal(unrelated.accepted, true);
});

test("assertion updates require named evidence and the current revision", () => {
	assert.equal(updateAssertion({ id: "A1", evidenceRef: "", evidenceRevision: "abc123", currentRevision: "abc123", changedPaths: [], assertionPaths: ["src/adapter.ts"] }).accepted, false);
	assert.equal(updateAssertion({ id: "A1", evidenceRef: "artifacts/evidence/a.json", evidenceRevision: "old", currentRevision: "abc123", changedPaths: [], assertionPaths: ["src/adapter.ts"] }).accepted, false);
});
