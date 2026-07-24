// Dispatch backend policy — pure logic for routing dispatch_agent calls to a
// native pi subagent or a same-name coms peer (.pi/agents/dispatch-policy.yaml).
// Parsing + resolution only: no I/O, no pi imports, testable under node --test.
// The wiring (pool lookup, envelope send, fallback spawn) lives in index.ts.

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_GRACE_S = 30;

export const DEFAULT_POLICY = Object.freeze({
	default: "native",
	grace_s: DEFAULT_GRACE_S,
	substitutions: {},
});

function stripComment(line) {
	// Values in this file never contain '#'; a minimal comment strip is enough.
	const i = line.indexOf("#");
	return i < 0 ? line : line.slice(0, i);
}

// Minimal parser for the specific dispatch-policy.yaml shape:
//   default: native | coms
//   grace_s: <seconds>
//   substitutions:
//     <member>:
//       prefer: native | coms
//       fallback: native | none
//       timeout_s: <seconds>
// Not a general YAML parser; tolerant of comments and blank lines only.
// Never throws: malformed input degrades to DEFAULT_POLICY pieces, with a
// warning per dropped construct so the hub can notify once.
export function parseDispatchPolicy(raw) {
	const policy = { default: "native", grace_s: DEFAULT_GRACE_S, substitutions: {} };
	const warnings = [];
	if (typeof raw !== "string" || raw.trim() === "") return { policy, warnings };

	let inSubstitutions = false;
	let currentMember = null;

	for (const rawLine of String(raw).split("\n")) {
		const line = stripComment(rawLine.replace(/\s+$/, ""));
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		const content = line.trim();
		const kv = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) {
			warnings.push(`dispatch-policy: ignored unparseable line: ${content}`);
			// Don't let fields after a broken member header leak into the previous member.
			currentMember = null;
			continue;
		}
		const [, key, value] = kv;

		if (indent === 0) {
			currentMember = null;
			inSubstitutions = false;
			if (key === "substitutions" && value === "") {
				inSubstitutions = true;
			} else if (key === "default") {
				if (value === "native" || value === "coms") policy.default = value;
				else warnings.push(`dispatch-policy: default must be native|coms, got "${value}"`);
			} else if (key === "grace_s") {
				const n = Number(value);
				if (Number.isFinite(n) && n >= 0) policy.grace_s = Math.floor(n);
				else warnings.push(`dispatch-policy: grace_s must be a non-negative number, got "${value}"`);
			} else {
				warnings.push(`dispatch-policy: unknown top-level key "${key}"`);
			}
			continue;
		}

		if (!inSubstitutions) continue;

		// Member header (one indent level, no value).
		if (value === "") {
			if (NAME_RE.test(key)) {
				currentMember = key.toLowerCase();
				policy.substitutions[currentMember] = { prefer: "coms", fallback: "native" };
			} else {
				warnings.push(`dispatch-policy: invalid member name "${key}"`);
				currentMember = null;
			}
			continue;
		}

		// Member field (deeper indent, key: value).
		if (!currentMember) {
			warnings.push(`dispatch-policy: field "${key}" outside a member block`);
			continue;
		}
		const sub = policy.substitutions[currentMember];
		if (key === "prefer") {
			if (value === "native" || value === "coms") sub.prefer = value;
			else warnings.push(`dispatch-policy: ${currentMember}.prefer must be native|coms, got "${value}"`);
		} else if (key === "fallback") {
			if (value === "native" || value === "none") sub.fallback = value;
			else warnings.push(`dispatch-policy: ${currentMember}.fallback must be native|none, got "${value}"`);
		} else if (key === "timeout_s") {
			const n = Number(value);
			if (Number.isFinite(n) && n > 0) sub.timeout_s = Math.floor(n);
			else warnings.push(`dispatch-policy: ${currentMember}.timeout_s must be a positive number, got "${value}"`);
		} else {
			warnings.push(`dispatch-policy: unknown field "${key}" for member ${currentMember}`);
		}
	}

	return { policy, warnings };
}

// Decide the backend for one dispatch. Pure: the caller supplies the CURRENT
// live pool peer names (peersInScope() at dispatch time — hub and peers boot
// in parallel, so this must never be cached from team activation).
//
// Returns one of:
//   { backend: "native" }
//   { backend: "native", comsMissedNotice: "<member> prefers a coms peer ..." }
//   { backend: "coms", peerName, timeout_s? }   — peerName is the pool's exact spelling
//   { backend: "await-coms", grace_s }          — coms-required, peer not live yet: poll, then refuse
export function resolveDispatchBackend({ agentName, policy, livePeerNames }) {
	const p = policy && typeof policy === "object" ? policy : DEFAULT_POLICY;
	const name = String(agentName || "").toLowerCase();
	const sub = (p.substitutions || {})[name];
	const prefer = sub ? sub.prefer : p.default === "coms" ? "coms" : "native";
	if (prefer !== "coms") return { backend: "native" };

	const live = Array.isArray(livePeerNames) ? livePeerNames : [];
	const match = live.find((n) => String(n).toLowerCase() === name);
	if (match !== undefined) {
		const out = { backend: "coms", peerName: String(match) };
		if (sub && sub.timeout_s) out.timeout_s = sub.timeout_s;
		return out;
	}

	if (sub && sub.fallback === "none") {
		return { backend: "await-coms", grace_s: Number.isFinite(p.grace_s) ? p.grace_s : DEFAULT_GRACE_S };
	}
	return {
		backend: "native",
		comsMissedNotice:
			`${agentName}: prefers a coms peer but none named "${name}" is live in the pool — using the native subagent.`,
	};
}

// The refusal returned when a coms-required member's peer never appeared
// within the grace window.
export function comsRequiredRefusal(agentName, graceS) {
	return (
		`"${agentName}" is configured as coms-required (fallback: none) but no live peer named ` +
		`"${String(agentName).toLowerCase()}" appeared in the pool within ${graceS}s. ` +
		"Start it with `just hub-team <team>` / `just team-up <team>`, widen the pool with /coms, " +
		"or set `fallback: native` in .pi/agents/dispatch-policy.yaml."
	);
}
