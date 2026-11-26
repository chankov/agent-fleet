import assert from "node:assert/strict";
import test from "node:test";
import { closeReview, comsAuthor, describeChangeAuthor, isChangeAuthor, nativeAuthor, OPERATOR_AUTHOR, sameChangeAuthor, selfAuthoredPaths, updateAssertion } from "./review-closure.ts";

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

test("change authors: a coms peer is its address whatever its session; an unknown address fails closed", () => {
	const session1 = comsAuthor({ address: "Peer-A", sessionId: "s1" });
	assert.equal(session1, 'coms:["peer-a","s1"]');
	assert.ok([OPERATOR_AUTHOR, nativeAuthor('["/w","editor--p2"]'), session1, comsAuthor(null)].every(isChangeAuthor));
	for (const invalid of ["", "native:", "coms:[]", 'coms:["",null]', 'coms:["a",""]', "reviewer", 42]) assert.equal(isChangeAuthor(invalid), false, String(invalid));
	assert.equal(sameChangeAuthor(session1, comsAuthor({ address: "peer-a", sessionId: "s1" })), true, "the same session, whatever its role");
	assert.equal(sameChangeAuthor(session1, comsAuthor({ address: "PEER-A", sessionId: "s2" })), true, "a restarted or resumed peer is the same author");
	assert.equal(sameChangeAuthor(session1, comsAuthor({ address: "peer-a" })), true, "an unknown session is the same address");
	assert.equal(sameChangeAuthor(session1, comsAuthor(null)), true, "an unknown peer could be the author");
	assert.equal(sameChangeAuthor(session1, comsAuthor({ address: "peer-b", sessionId: "s1" })), false);
	assert.equal(sameChangeAuthor(nativeAuthor('["/w","editor"]'), nativeAuthor('["/w","editor--p2"]')), false, "native instances are distinct");
	assert.equal(sameChangeAuthor(comsAuthor(null), nativeAuthor('["/w","reviewer"]')), false, "a native run is never a coms peer");
	assert.equal(sameChangeAuthor(OPERATOR_AUTHOR, nativeAuthor('["/w","reviewer"]')), false);
	assert.equal(describeChangeAuthor(nativeAuthor('["/w","editor--p2"]')), "native instance editor--p2");
	assert.equal(describeChangeAuthor(comsAuthor({ address: "peer-a" })), "coms peer peer-a (session unknown)");
});

test("self-authored paths are the reviewer's own files inside the review scope", () => {
	const editor = nativeAuthor('["/w","editor"]'), peer = comsAuthor({ address: "peer-a", sessionId: "s1" });
	const authors = { "src/api/index.ts": [editor], "src/client/index.ts": [editor, peer] };
	assert.deepEqual(selfAuthoredPaths(authors, comsAuthor({ address: "peer-a", sessionId: "s1" }), ["src"]), ["src/client/index.ts"]);
	assert.deepEqual(selfAuthoredPaths(authors, peer, ["src/api"]), [], "outside the review scope");
	assert.deepEqual(selfAuthoredPaths(authors, nativeAuthor('["/w","reviewer"]'), ["src"]), []);
	assert.deepEqual(selfAuthoredPaths(undefined, peer, ["src"]), [], "an older state has no recorded authors");
});
