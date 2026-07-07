import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_POLICY,
	comsRequiredRefusal,
	parseDispatchPolicy,
	resolveDispatchBackend,
} from "./backend-policy.js";

const SAMPLE = `
# Backend routing for dispatch_agent.
default: native
grace_s: 20

substitutions:
  plan-reviewer:
    prefer: coms
    fallback: native
  code-reviewer:
    prefer: coms
    fallback: none
    timeout_s: 3600
  documenter:
    prefer: coms
`;

test("parseDispatchPolicy parses the documented shape", () => {
	const { policy, warnings } = parseDispatchPolicy(SAMPLE);
	assert.deepEqual(warnings, []);
	assert.equal(policy.default, "native");
	assert.equal(policy.grace_s, 20);
	assert.deepEqual(policy.substitutions["plan-reviewer"], { prefer: "coms", fallback: "native" });
	assert.deepEqual(policy.substitutions["code-reviewer"], { prefer: "coms", fallback: "none", timeout_s: 3600 });
	// A bare member block defaults to prefer coms + native fallback.
	assert.deepEqual(policy.substitutions["documenter"], { prefer: "coms", fallback: "native" });
});

test("parseDispatchPolicy tolerates empty/missing input", () => {
	for (const raw of ["", "   \n", null, undefined]) {
		const { policy, warnings } = parseDispatchPolicy(raw);
		assert.deepEqual(policy, { default: "native", grace_s: 30, substitutions: {} });
		assert.deepEqual(warnings, []);
	}
});

test("parseDispatchPolicy drops bad values with warnings instead of throwing", () => {
	const { policy, warnings } = parseDispatchPolicy(`
default: quantum
grace_s: soon
bogus: yes
substitutions:
  code-reviewer:
    prefer: maybe
    fallback: shrug
    timeout_s: -5
    surprise: 1
  "bad name!":
    prefer: coms
`);
	assert.equal(policy.default, "native");
	assert.equal(policy.grace_s, 30);
	// Member exists with safe defaults despite every field being rejected.
	assert.deepEqual(policy.substitutions["code-reviewer"], { prefer: "coms", fallback: "native" });
	assert.equal(Object.keys(policy.substitutions).length, 1);
	// 7 bad values/keys + the unparseable member header + the field stranded after it.
	assert.equal(warnings.length, 9);
});

test("parseDispatchPolicy member names are case-insensitive keys", () => {
	const { policy } = parseDispatchPolicy("substitutions:\n  Code-Reviewer:\n    prefer: coms\n");
	assert.ok(policy.substitutions["code-reviewer"]);
});

test("resolveDispatchBackend: native default leaves everything native", () => {
	const { policy } = parseDispatchPolicy("default: native\n");
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "builder", policy, livePeerNames: ["builder"] }),
		{ backend: "native" },
	);
});

test("resolveDispatchBackend: substitution + live peer routes to coms with the pool's exact name", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({
		agentName: "Code-Reviewer",
		policy,
		livePeerNames: ["documenter", "code-reviewer"],
	});
	assert.deepEqual(r, { backend: "coms", peerName: "code-reviewer", timeout_s: 3600 });
});

test("resolveDispatchBackend: prefer coms + no live peer + fallback native → native with notice", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({ agentName: "plan-reviewer", policy, livePeerNames: [] });
	assert.equal(r.backend, "native");
	assert.match(r.comsMissedNotice, /plan-reviewer.*native subagent/);
});

test("resolveDispatchBackend: coms-required + no live peer → await-coms with grace", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({ agentName: "code-reviewer", policy, livePeerNames: [] });
	assert.deepEqual(r, { backend: "await-coms", grace_s: 20 });
});

test("resolveDispatchBackend: default coms substitutes any live same-name peer", () => {
	const { policy } = parseDispatchPolicy("default: coms\n");
	assert.equal(
		resolveDispatchBackend({ agentName: "builder", policy, livePeerNames: ["builder"] }).backend,
		"coms",
	);
	// No live peer → plain native fallback (default-mode members are never required).
	const r = resolveDispatchBackend({ agentName: "builder", policy, livePeerNames: [] });
	assert.equal(r.backend, "native");
	assert.ok(r.comsMissedNotice);
});

test("resolveDispatchBackend survives a missing/garbage policy", () => {
	for (const policy of [null, undefined, 42, DEFAULT_POLICY]) {
		assert.deepEqual(
			resolveDispatchBackend({ agentName: "code-reviewer", policy, livePeerNames: ["code-reviewer"] }),
			{ backend: "native" },
		);
	}
});

test("comsRequiredRefusal names the member, the grace window, and the remedies", () => {
	const msg = comsRequiredRefusal("Code-Reviewer", 20);
	assert.match(msg, /coms-required/);
	assert.match(msg, /20s/);
	assert.match(msg, /hub-team/);
	assert.match(msg, /fallback: native/);
});
