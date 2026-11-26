import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_POLICY,
	comsRequiredRefusal,
	explicitComsRefusal,
	parseDispatchPolicy,
	policyRoute,
	resolveDispatchBackend,
} from "./backend-policy.js";

const SAMPLE = `
# Backend routing for dispatch_agent.
default: native
grace_s: 20

routes:
  reviewer:
    peer: claude-reviewer
    prefer: coms
    fallback: none
    timeout_s: 3600
  editor:
    prefer: coms
`;

test("parseDispatchPolicy parses role routes with a distinct peer address", () => {
	const { policy, warnings } = parseDispatchPolicy(SAMPLE);
	assert.deepEqual(warnings, []);
	assert.equal(policy.default, "native");
	assert.equal(policy.grace_s, 20);
	assert.deepEqual(policy.substitutions.reviewer, { peer: "claude-reviewer", prefer: "coms", fallback: "none", timeout_s: 3600 });
	// A bare role block defaults to prefer coms + native fallback, peer = role name.
	assert.deepEqual(policy.substitutions.editor, { prefer: "coms", fallback: "native" });
});

test("parseDispatchPolicy keeps the legacy substitutions spelling but only for roles", () => {
	const { policy, warnings } = parseDispatchPolicy("substitutions:\n  Reviewer:\n    prefer: coms\n  code-reviewer:\n    prefer: coms\n");
	assert.ok(policy.substitutions.reviewer);
	assert.equal(policy.substitutions["code-reviewer"], undefined);
	assert.equal(warnings.length, 2, "the retired member header and its stranded field are reported");
	assert.match(warnings[0], /"code-reviewer" is not a role; routes are keyed by researcher, reviewer or editor/);
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
routes:
  reviewer:
    peer: "not an address!"
    prefer: maybe
    fallback: shrug
    timeout_s: -5
    surprise: 1
  "bad name!":
    prefer: coms
`);
	assert.equal(policy.default, "native");
	assert.equal(policy.grace_s, 30);
	// The role exists with safe defaults despite every field being rejected.
	assert.deepEqual(policy.substitutions.reviewer, { prefer: "coms", fallback: "native" });
	assert.equal(Object.keys(policy.substitutions).length, 1);
	// 8 bad values/keys + the unparseable header + the field stranded after it.
	assert.equal(warnings.length, 10);
});

test("a parallel instance uses its role's route", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	assert.equal(policyRoute(policy, "reviewer--p3")?.peer, "claude-reviewer");
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "reviewer--p2", policy, livePeerNames: ["claude-reviewer"] }),
		{ backend: "coms", peerName: "claude-reviewer", timeout_s: 3600 },
	);
});

test("resolveDispatchBackend: explicit native bypasses a live peer", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "reviewer", policy, livePeerNames: ["claude-reviewer"], requestedBackend: "native" }),
		{ backend: "native" },
	);
});

test("resolveDispatchBackend: explicit coms requires the route's live peer without fallback", () => {
	const { policy } = parseDispatchPolicy("default: native\n");
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: ["Editor"], requestedBackend: "coms" }),
		{ backend: "coms", peerName: "Editor", explicit: true },
	);
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: [], requestedBackend: "coms" }),
		{ backend: "coms-unavailable" },
	);
	const routed = parseDispatchPolicy(SAMPLE).policy;
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "reviewer", policy: routed, livePeerNames: ["reviewer", "claude-reviewer"], requestedBackend: "coms" }),
		{ backend: "coms", peerName: "claude-reviewer", explicit: true, timeout_s: 3600 },
		"the peer address, not a same-name peer, receives the route",
	);
});

test("resolveDispatchBackend: unknown explicit backend fails closed", () => {
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "editor", policy: DEFAULT_POLICY, livePeerNames: [], requestedBackend: "remote" }),
		{ backend: "invalid", requestedBackend: "remote" },
	);
});

test("explicitComsRefusal names the required peer and remedies", () => {
	const msg = explicitComsRefusal("Reviewer");
	assert.match(msg, /explicit coms backend/);
	assert.match(msg, /reviewer/);
	assert.match(msg, /herdr_spawn_peer/);
	assert.match(msg, /backend: native|backend: auto/);
});

test("resolveDispatchBackend: native default leaves everything native", () => {
	const { policy } = parseDispatchPolicy("default: native\n");
	assert.deepEqual(
		resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: ["editor"] }),
		{ backend: "native" },
	);
});

test("resolveDispatchBackend: a route + live peer reaches coms with the pool's exact name", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({ agentName: "Reviewer", policy, livePeerNames: ["editor", "Claude-Reviewer"] });
	assert.deepEqual(r, { backend: "coms", peerName: "Claude-Reviewer", timeout_s: 3600 });
});

test("resolveDispatchBackend: prefer coms + no live peer + fallback native → native with notice", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: [] });
	assert.equal(r.backend, "native");
	assert.match(r.comsMissedNotice, /editor.*none named "editor".*native subagent/);
});

test("resolveDispatchBackend: coms-required + no live peer → await-coms with grace", () => {
	const { policy } = parseDispatchPolicy(SAMPLE);
	const r = resolveDispatchBackend({ agentName: "reviewer", policy, livePeerNames: ["reviewer"] });
	assert.deepEqual(r, { backend: "await-coms", grace_s: 20 }, "a same-name peer is not the route's peer");
});

test("resolveDispatchBackend: default coms sends any role to a live peer named like the role", () => {
	const { policy } = parseDispatchPolicy("default: coms\n");
	assert.equal(resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: ["editor"] }).backend, "coms");
	// No live peer → plain native fallback (default-mode roles are never required).
	const r = resolveDispatchBackend({ agentName: "editor", policy, livePeerNames: [] });
	assert.equal(r.backend, "native");
	assert.ok(r.comsMissedNotice);
});

test("resolveDispatchBackend survives a missing/garbage policy", () => {
	for (const policy of [null, undefined, 42, DEFAULT_POLICY]) {
		assert.deepEqual(
			resolveDispatchBackend({ agentName: "reviewer", policy, livePeerNames: ["reviewer"] }),
			{ backend: "native" },
		);
	}
});

test("comsRequiredRefusal names the member, the grace window, and the remedies", () => {
	const msg = comsRequiredRefusal("Reviewer", 20);
	assert.match(msg, /coms-required/);
	assert.match(msg, /20s/);
	assert.match(msg, /just fleet peer reviewer/);
	assert.doesNotMatch(msg, /hub-team|team-up/);
	assert.match(msg, /fallback: native/);
});
