/**
 * Shared exemption + escalation plumbing for damage-control-continue and agent-hub.
 *
 * Exemptions are runtime, session-scoped allowances layered on top of
 * `.pi/damage-control-rules.yaml` — they never edit the rules file and only
 * ever apply to the path categories (zeroAccessPaths / readOnlyPaths /
 * noDeletePaths), never to the destructive bashToolPatterns.
 *
 * Consumers:
 *  - damage-control-continue — /allow commands, block-time prompts, and
 *    escalation to the agent-hub dispatcher from headless children
 *  - agent-hub — computes the shared file path, passes the env plumbing to
 *    spawned children, and answers access_request envelopes on its coms socket
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// Env plumbing agent-hub sets on spawned children. spawnPiAgent spreads
// process.env, so delegate grandchildren inherit these for free.
export const ASK_ENDPOINT_ENV = "AGENT_HUB_ASK_ENDPOINT";
export const EXEMPTIONS_FILE_ENV = "AGENT_HUB_EXEMPTIONS_FILE";
export const AGENT_ID_ENV = "AGENT_HUB_AGENT_ID";

export type ExemptionScope = "turn" | "session";
export type PathRuleCategory = "zero_access" | "read_only" | "no_delete";

export interface Exemption {
	/** The protected pattern being unlocked — same syntax as the rules file entries. */
	pattern: string;
	scope: ExemptionScope;
	/** When set, the exemption applies only to the spawned agent with this id. */
	agent?: string;
	grantedVia: "command" | "prompt" | "escalation";
	grantedAt: string;
}

// ── shared exemptions file (one per hub session, read by spawned children) ──

export function exemptionsFilePath(sessionId: string): string {
	const comsDir = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
	return path.join(comsDir, "exemptions", `${sessionId}.json`);
}

export function readExemptionsFile(filePath: string | undefined): Exemption[] {
	if (!filePath) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((e): e is Exemption => !!e && typeof e.pattern === "string" && e.pattern.length > 0);
	} catch {
		return [];
	}
}

/** Exemptions visible to one process: agent-agnostic entries plus those granted to `agentId`. */
export function fileExemptionsFor(filePath: string | undefined, agentId: string | undefined): Exemption[] {
	return readExemptionsFile(filePath).filter((e) => !e.agent || e.agent === agentId);
}

export function appendExemptionToFile(filePath: string, exemption: Exemption): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const existing = readExemptionsFile(filePath);
	const dup = existing.some((e) => e.pattern === exemption.pattern && (e.agent ?? "") === (exemption.agent ?? ""));
	if (!dup) existing.push(exemption);
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
	fs.renameSync(tmp, filePath);
}

/** Remove every entry for `pattern` (any agent). Returns true when something was removed. */
export function removeExemptionFromFile(filePath: string | undefined, pattern: string): boolean {
	if (!filePath) return false;
	const existing = readExemptionsFile(filePath);
	const next = existing.filter((e) => e.pattern !== pattern);
	if (next.length === existing.length) return false;
	try {
		const tmp = `${filePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
		fs.renameSync(tmp, filePath);
		return true;
	} catch {
		return false;
	}
}

// ── escalation protocol (headless child → hub dispatcher) ──

/**
 * Sent by a child's damage-control-continue to the hub's coms socket. Carries
 * the Envelope base fields (sender_session = agent id, sender_endpoint = "")
 * so the hub's isValidEnvelope accepts it.
 */
export interface AccessRequest {
	type: "access_request";
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
	agent: string;
	tool: string;
	rule: string;
	pattern: string;
	category: PathRuleCategory;
	invocation: string;
}

export type AccessDecisionChoice = "deny" | "allow_once" | "allow_agent" | "allow_all";

/** Protected deletions are approved per invocation; broader grants stay operator-explicit. */
export function accessDecisionChoices(category: PathRuleCategory): AccessDecisionChoice[] {
	return category === "no_delete"
		? ["deny", "allow_once"]
		: ["deny", "allow_once", "allow_agent", "allow_all"];
}

/** Coalesce identical asks without letting one delete approval cover sibling paths. */
export function accessRequestCacheKey(
	request: Pick<AccessRequest, "agent" | "pattern" | "category" | "invocation">,
): string {
	const base = `${request.agent}::${request.pattern}`;
	return request.category === "no_delete" ? `${base}::${request.invocation}` : base;
}

export interface AccessDecision {
	type: "access_decision";
	msg_id: string;
	decision: AccessDecisionChoice;
}

export const ESCALATION_TIMEOUT_MS = Number(process.env.AGENT_HUB_ASK_TIMEOUT_MS) || 60_000;

/**
 * Ask the hub to approve a blocked call. Synchronous over a single connection:
 * the child has no socket server of its own, so the hub keeps this socket open
 * and writes the decision line whenever the user answers. Resolves "timeout" /
 * "error" instead of rejecting — callers always fail closed.
 */
export function requestAccessFromHub(
	endpoint: string,
	request: AccessRequest,
	timeoutMs: number = ESCALATION_TIMEOUT_MS,
): Promise<AccessDecisionChoice | "timeout" | "error"> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let sock: net.Socket;
		const settle = (v: AccessDecisionChoice | "timeout" | "error") => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(v);
		};
		try {
			sock = net.createConnection({ path: endpoint });
		} catch {
			resolve("error");
			return;
		}
		timer = setTimeout(() => settle("timeout"), timeoutMs);
		let buf = "";
		sock.on("connect", () => {
			try {
				sock.write(JSON.stringify(request) + "\n");
			} catch {
				settle("error");
			}
		});
		sock.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				const parsed = JSON.parse(buf.slice(0, nl));
				if (
					parsed &&
					parsed.type === "access_decision" &&
					(parsed.decision === "deny" || parsed.decision === "allow_once" ||
						parsed.decision === "allow_agent" || parsed.decision === "allow_all")
				) {
					settle(parsed.decision);
				} else {
					// nack or unknown reply (e.g. an older hub without escalation support)
					settle("error");
				}
			} catch {
				settle("error");
			}
		});
		sock.on("error", () => settle("error"));
		sock.on("close", () => settle("error"));
	});
}
