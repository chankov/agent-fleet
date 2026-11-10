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
import { parse as parseYaml } from 'yaml';
import { safeSourceRead } from './safe-source-read.js';
import { readDamagePolicy } from './damage-policy.ts';
import { sessionRootsFromEnv } from './workspace-context.ts';

/** Explicit file-access check for consumers outside the named tool hook. Invalid policy fails closed. */
export function currentFileAccessAllowed(root: string, target: string): boolean {
 try {
  const roots=sessionRootsFromEnv();
  if(roots?.mode==='targeted') {
   if(fs.realpathSync(root)!==roots.executionRoot)return false;
   const policy=readDamagePolicy(root)!;
   return !policy.rules.zeroAccessPaths.some(p=>damageControlPathMatches(path.resolve(root,target),p,roots.executionRoot));
  }
 } catch { return false; }
 const project = path.join(root, '.pi/damage-control-rules.yaml');
 const global = path.join(os.homedir(), '.pi/damage-control-rules.yaml');
 try {
  const selected = fs.existsSync(project) ? project : fs.existsSync(global) ? global : null;
  if (!selected) return true;
  const policy = parseYaml(safeSourceRead(selected === project ? root : os.homedir(), selected, 65536).toString('utf8'));
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || (policy.zeroAccessPaths !== undefined && (!Array.isArray(policy.zeroAccessPaths) || policy.zeroAccessPaths.some((p: unknown) => typeof p !== 'string')))) return false;
  return !(policy.zeroAccessPaths ?? []).some((p: string) => damageControlPathMatches(path.resolve(root, target), p, root));
 } catch { return false; }
}

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
	/** Diagnostic correlation only; these fields never authorize access. */
	toolCallId?: string;
	traceOwner?: string;
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
	/** Bounded display text only; never use a truncated preview as action identity. */
	invocation: string;
	/** SHA-256 of complete tool/cwd/input/category/pattern identity; optional for legacy callers. */
	actionDigest?: string;
	/** Absolute Unix epoch milliseconds; legacy callers are bounded at receipt. */
	deadline?: number;
	/** Per-spawn cooperative epoch; old children cannot inherit a new task's approval. */
	accessEpoch?: string;
	exactAction?: {tool:string;cwd:string;input:unknown;category:string;pattern:string};
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
	request: Pick<AccessRequest, "agent" | "pattern" | "category" | "invocation" | "actionDigest">,
): string {
	// Structured tuples avoid delimiter collisions and category confusion.
	return JSON.stringify([request.agent, request.pattern, request.category,
		request.category === 'no_delete' ? request.actionDigest ?? request.invocation : null]);
}

export interface AccessDecision {
	type: "access_decision";
	msg_id: string;
	decision: AccessDecisionChoice;
	decisionSource?: 'codex_machine' | 'local_human';
	outcome?: 'expired' | 'cancelled' | 'stale' | 'unsupported' | 'audit_failed';
	actionDigest?: string;
}

export const ESCALATION_TIMEOUT_MS = Number(process.env.AGENT_HUB_ASK_TIMEOUT_MS) || 60_000;

/**
 * Ask the hub to approve a blocked call. Synchronous over a single connection:
 * the child has no socket server of its own, so the hub keeps this socket open
 * and writes the decision line whenever the user answers. Resolves "timeout" /
 * "error" instead of rejecting — callers always fail closed.
 */
export interface AccessReceipt {
 status:'decided'|'expired'|'cancelled'|'stale'|'unsupported'|'invalid_reply'|'disconnected'|'transport_error'|'audit_failed';
 msg_id:string; actionDigest?:string; decision?:AccessDecisionChoice; decisionSource?:'codex_machine'|'local_human'|'legacy_unattested';
}
export async function requestAccessFromHub(endpoint:string,request:AccessRequest,timeoutMs:number=ESCALATION_TIMEOUT_MS):Promise<AccessDecisionChoice|'machine_deny'|'timeout'|'error'>{
 const r=await requestAccessReceiptFromHub(endpoint,request,timeoutMs);
 return r.status==='decided'?(r.decision==='deny'&&r.decisionSource==='codex_machine'?'machine_deny':r.decision!):r.status==='expired'?'timeout':'error';
}
export function requestAccessReceiptFromHub(
	endpoint: string,
	request: AccessRequest,
	timeoutMs: number = ESCALATION_TIMEOUT_MS,
): Promise<AccessReceipt> {
 return new Promise((resolve) => {
  const failure=(status:AccessReceipt['status']):AccessReceipt=>({status,msg_id:request.msg_id,actionDigest:request.actionDigest});
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
			(request.deadline !== undefined && !Number.isSafeInteger(request.deadline))) { resolve(failure('invalid_reply')); return; }
		const deadline = Math.min(request.deadline ?? Infinity, Date.now() + timeoutMs);
		if (deadline <= Date.now()) { resolve(failure('expired')); return; }
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let sock: net.Socket;
		const settle = (v:AccessDecisionChoice|'machine_deny'|'timeout'|'error'|AccessReceipt['status'],source?:AccessReceipt['decisionSource']) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try { sock.destroy(); } catch { /* ignore */ }
   resolve(['deny','allow_once','allow_agent','allow_all','machine_deny'].includes(v)?{...failure('decided'),decision:v==='machine_deny'?'deny':v as AccessDecisionChoice,decisionSource:v==='machine_deny'?'codex_machine':source??'legacy_unattested'}:failure(v==='timeout'?'expired':v==='error'?'invalid_reply':v as AccessReceipt['status']));
		};
		try {
			sock = net.createConnection({ path: endpoint });
		} catch {
   resolve(failure('transport_error'));
			return;
		}
		timer = setTimeout(() => settle("timeout"), Math.max(1, deadline - Date.now()));
		let buf = "";
		sock.on("connect", () => {
			try {
				if (Date.now() >= deadline) { settle('timeout'); return; }
				sock.write(JSON.stringify({ ...request, deadline }) + "\n");
			} catch {
				settle("error");
			}
		});
		sock.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
            if(Buffer.byteLength(buf)>32768){settle('error');return;}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				if (Date.now() >= deadline) { settle('timeout'); return; }
				const parsed = JSON.parse(buf.slice(0, nl));
                if(parsed?.type==='access_decision'&&parsed.msg_id===request.msg_id&&parsed.outcome!==undefined){settle(['expired','cancelled','stale','unsupported','audit_failed'].includes(parsed.outcome)?parsed.outcome:'invalid_reply');return;}
				if (
					parsed &&
					parsed.type === "access_decision" && parsed.msg_id === request.msg_id &&
                    (parsed.actionDigest === undefined || parsed.actionDigest === request.actionDigest) &&
                    (parsed.decisionSource !== 'codex_machine' || typeof request.actionDigest==='string' && parsed.actionDigest === request.actionDigest && ['allow_once','deny'].includes(parsed.decision)) &&
					(parsed.decision === "deny" || parsed.decision === "allow_once" ||
						parsed.decision === "allow_agent" || parsed.decision === "allow_all")
				) {
					settle(parsed.decision==='deny'&&parsed.decisionSource==='codex_machine'?'machine_deny':parsed.decision,parsed.decisionSource==='local_human'?'local_human':parsed.decisionSource==='codex_machine'?'codex_machine':undefined);
				} else {
					// nack or unknown reply (e.g. an older hub without escalation support)
					settle("error");
				}
			} catch {
				settle("error");
			}
		});
		sock.on("error", () => settle("transport_error"));
  sock.on("close", () => settle("disconnected"));
	});
}

export function damageControlPathMatches(targetPath: string, pattern: string, cwd: string): boolean {
	const resolvedPattern = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : pattern;
	if (resolvedPattern.endsWith("/")) {
		const absolutePattern = path.isAbsolute(resolvedPattern) ? resolvedPattern : path.resolve(cwd, resolvedPattern);
		return targetPath.startsWith(absolutePattern);
	}
	const regexPattern = resolvedPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);
	const relativePath = path.relative(cwd, targetPath);
	// Relative policy patterns describe paths inside the execution root, not
	// ancestors of that root (e.g. macOS /private/var must not match private/**
	// for every public project file). Keep absolute/home patterns and paths
	// outside cwd on the existing full-path matching contract.
	const withinCwd = relativePath === "" || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
	const candidates = !path.isAbsolute(resolvedPattern) && path.isAbsolute(targetPath) && withinCwd ? [relativePath] : [targetPath, relativePath];
	return candidates.some(candidate => regex.test(candidate) || candidate.includes(resolvedPattern));
}
