/**
 * Damage-Control (continue) — same rules as damage-control, but the agent keeps working
 *
 * Difference from damage-control/index.ts:
 *   - The blocked tool result is replaced with actionable feedback that
 *     distinguishes destructive vs non-destructive intent and tells the
 *     agent how to adapt.
 *   - We do NOT call ctx.abort(), so the agent's turn continues and can
 *     try an alternate path (e.g. assume a .env key exists instead of
 *     reading it to verify).
 *
 * On top of the rule engine this variant supports runtime EXEMPTIONS for the
 * path categories (zeroAccessPaths / readOnlyPaths / noDeletePaths) — never
 * for the destructive bashToolPatterns:
 *   - /allow <pattern> [turn|session] pre-authorizes a protected pattern
 *     (/allowed lists, /revoke removes). Session grants are mirrored into the
 *     shared exemptions file when agent-hub provides one, so spawned children
 *     inherit them.
 *   - In interactive sessions a path block opens a dialog (keep blocked /
 *     allow once / turn / session) — an approved call proceeds immediately.
 *   - In headless children spawned by agent-hub (ctx.hasUI is false and
 *     AGENT_HUB_ASK_ENDPOINT is set) a path block escalates to the hub
 *     dispatcher over its coms socket and waits for the user's decision;
 *     timeout or denial fails closed.
 *
 * In this repo it is the default guardrail for the orchestrator/dispatcher
 * (the agent-hub main session) and for spawned research helpers, which need
 * to recover from a blocked read and keep going rather than abort the turn.
 * Other specialists (builder, etc.) keep the hard-stop damage-control harness.
 *
 * Usage: pi -e .pi/harnesses/damage-control-continue/index.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
	AGENT_ID_ENV,
	ASK_ENDPOINT_ENV,
	EXEMPTIONS_FILE_ENV,
	appendExemptionToFile,
	fileExemptionsFor,
	readExemptionsFile,
	removeExemptionFromFile,
	requestAccessFromHub,
	type AccessRequest,
	type Exemption,
	type ExemptionScope,
} from "../damage-control/shared.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

// Cap on hub escalations per agent run, so a confused child cannot flood the
// dispatcher with approval dialogs. Denials are also cached per turn.
const MAX_ESCALATIONS_PER_TURN = 3;
const PROMPT_TIMEOUT_MS = 60_000;

function continueFeedback(toolName: string, violationReason: string, invocation: string, note?: string): string {
	return [
		`🛡️ Damage-Control: ${toolName} blocked — ${violationReason}`,
		``,
		`Attempted: ${invocation}`,
		...(note ? [``, note] : []),
		``,
		`Don't call ${toolName} directly like this. Decide which case you're in and continue:`,
		``,
		`→ NON-DESTRUCTIVE (e.g. reading .env to verify a key, listing a protected dir, peeking at config):`,
		`   Assume the data is present and correct. Skip the verification step and move on with the task.`,
		`   Example: if you were reading .env to confirm a key exists, just assume it does — the user has`,
		`   configured their environment. If you actually need a value, ask the user for it explicitly.`,
		``,
		`→ DESTRUCTIVE (delete, overwrite, force-push, drop, rm, truncate, sudo, kill, etc.):`,
		`   STOP. Tell the user exactly what you need to ship this task and ask how they want to proceed.`,
		`   Do not invent a workaround that achieves the same destructive effect.`,
		``,
		`Pick the right path above and continue working. Do not retry this exact call.`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = {
		bashToolPatterns: [],
		zeroAccessPaths: [],
		readOnlyPaths: [],
		noDeletePaths: [],
	};

	// Runtime exemptions. Turn-scoped entries (and per-turn denial memory) are
	// cleared on agent_end; session-scoped entries live for the process. The
	// shared exemptions file (agent-hub plumbing) is re-read on every block, so
	// grants made mid-session in the hub apply to already-running children.
	const turnExemptions: Exemption[] = [];
	const sessionExemptions: Exemption[] = [];
	const deniedThisTurn = new Set<string>();
	let escalationsThisTurn = 0;

	const agentId = () => process.env[AGENT_ID_ENV] || "unknown-agent";
	const askEndpoint = () => process.env[ASK_ENDPOINT_ENV];
	const sharedExemptionsFile = () => process.env[EXEMPTIONS_FILE_ENV];

	function activeExemptions(): Exemption[] {
		return [...turnExemptions, ...sessionExemptions, ...fileExemptionsFor(sharedExemptionsFile(), agentId())];
	}

	function grantExemption(pattern: string, scope: ExemptionScope, via: Exemption["grantedVia"]): Exemption {
		const ex: Exemption = { pattern, scope, grantedVia: via, grantedAt: new Date().toISOString() };
		(scope === "turn" ? turnExemptions : sessionExemptions).push(ex);
		if (scope === "session") {
			const file = sharedExemptionsFile();
			if (file) {
				try { appendExemptionToFile(file, ex); } catch { /* best-effort — memory copy still applies */ }
			}
		}
		pi.appendEntry("damage-control-log", { action: "exemption_granted", pattern, scope, via });
		return ex;
	}

	function resolvePath(p: string, cwd: string): string {
		if (p.startsWith("~")) {
			p = path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(cwd, p);
	}

	function expandTilde(p: string): string {
		return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
	}

	function commandReferencesPath(command: string, protectedPath: string): boolean {
		if (!protectedPath) return false;
		let idx = command.indexOf(protectedPath);
		while (idx >= 0) {
			const after = command[idx + protectedPath.length];
			if (!after || !/[A-Za-z0-9_-]/.test(after)) return true;
			idx = command.indexOf(protectedPath, idx + 1);
		}
		return false;
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
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

		return regex.test(targetPath) || regex.test(relativePath) || targetPath.includes(resolvedPattern) || relativePath.includes(resolvedPattern);
	}

	// An exemption unlocks the exact protected pattern it names, or any target
	// it would itself match under the same rules the block used.
	function exemptionApplies(ex: Exemption, matchedPattern: string, inputPaths: string[], command: string | null, cwd: string): boolean {
		if (ex.pattern === matchedPattern) return true;
		if (command && command.includes(ex.pattern)) return true;
		for (const p of inputPaths) {
			if (isPathMatch(resolvePath(p, cwd), ex.pattern, cwd)) return true;
		}
		return false;
	}

	function statusText(): string {
		const total = rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
		const exemptions = turnExemptions.length + sessionExemptions.length + readExemptionsFile(sharedExemptionsFile()).length;
		return exemptions > 0
			? `🛡️ Damage-Control (continue): ${total} Rules, ${exemptions} exemption${exemptions === 1 ? "" : "s"}`
			: `🛡️ Damage-Control (continue): ${total} Rules`;
	}

	pi.registerCommand("allow", {
		description: "Damage-control: exempt a protected path pattern — /allow <pattern> [turn|session]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			let scope: ExemptionScope = "session";
			const last = parts[parts.length - 1];
			if (last === "turn" || last === "session") {
				scope = last;
				parts.pop();
			}
			const pattern = parts.join(" ");
			if (!pattern) {
				ctx.ui.notify("Usage: /allow <pattern> [turn|session] — e.g. /allow .env turn", "warning");
				return;
			}
			const already = activeExemptions().some((e) => e.pattern === pattern && (e.scope === scope || e.scope === "session"));
			if (already) {
				ctx.ui.notify(`🛡️ ${pattern} is already exempted`, "info");
				return;
			}
			grantExemption(pattern, scope, "command");
			ctx.ui.notify(`🛡️ Exemption granted: ${pattern} (${scope})`, "warning");
			ctx.ui.setStatus("damage-control", statusText());
		},
	});

	pi.registerCommand("allowed", {
		description: "Damage-control: list active exemptions",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			for (const e of turnExemptions) lines.push(`${e.pattern} (turn, via ${e.grantedVia})`);
			for (const e of sessionExemptions) lines.push(`${e.pattern} (session, via ${e.grantedVia})`);
			for (const e of readExemptionsFile(sharedExemptionsFile())) {
				lines.push(`${e.pattern} (session${e.agent ? `, agent ${e.agent}` : ", all agents"}, via ${e.grantedVia})`);
			}
			ctx.ui.notify(lines.length ? `🛡️ Active exemptions:\n${lines.join("\n")}` : "🛡️ No active exemptions", "info");
		},
	});

	pi.registerCommand("revoke", {
		description: "Damage-control: revoke an exemption — /revoke <pattern>",
		handler: async (args, ctx) => {
			const pattern = args.trim();
			if (!pattern) {
				ctx.ui.notify("Usage: /revoke <pattern>", "warning");
				return;
			}
			let removed = false;
			for (const store of [turnExemptions, sessionExemptions]) {
				for (let i = store.length - 1; i >= 0; i--) {
					if (store[i].pattern === pattern) {
						store.splice(i, 1);
						removed = true;
					}
				}
			}
			if (removeExemptionFromFile(sharedExemptionsFile(), pattern)) removed = true;
			if (removed) {
				pi.appendEntry("damage-control-log", { action: "exemption_revoked", pattern });
				ctx.ui.notify(`🛡️ Exemption revoked: ${pattern}`, "warning");
			} else {
				ctx.ui.notify(`🛡️ No exemption found for: ${pattern}`, "info");
			}
			ctx.ui.setStatus("damage-control", statusText());
		},
	});

	pi.on("agent_end", async () => {
		turnExemptions.length = 0;
		deniedThisTurn.clear();
		escalationsThisTurn = 0;
	});

	pi.on("session_start", async (_event, ctx) => {
		const projectRulesPath = path.join(ctx.cwd, ".pi", "damage-control-rules.yaml");
		const globalRulesPath = path.join(os.homedir(), ".pi", "damage-control-rules.yaml");
		const rulesPath = fs.existsSync(projectRulesPath) ? projectRulesPath : fs.existsSync(globalRulesPath) ? globalRulesPath : null;
		try {
			if (rulesPath) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = yamlParse(content) as Partial<Rules>;
				rules = {
					bashToolPatterns: loaded.bashToolPatterns || [],
					zeroAccessPaths: loaded.zeroAccessPaths || [],
					readOnlyPaths: loaded.readOnlyPaths || [],
					noDeletePaths: loaded.noDeletePaths || [],
				};
				const source = rulesPath === projectRulesPath ? "project" : "global";
				const total = rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
				ctx.ui.notify(`🛡️ Damage-Control (continue): Loaded ${total} rules (${source}). Blocks deliver feedback so the agent can adapt and keep working.`);
			} else {
				ctx.ui.notify("🛡️ Damage-Control (continue): No rules found at .pi/damage-control-rules.yaml (project or global)");
			}
		} catch (err) {
			ctx.ui.notify(`🛡️ Damage-Control (continue): Failed to load rules: ${err instanceof Error ? err.message : String(err)}`);
		}

		ctx.ui.setStatus("damage-control", statusText());
	});

	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;
		// The protected pattern that matched, set only for the path categories —
		// those are exemptible/escalatable. Destructive bashToolPatterns leave
		// this null and can never be exempted.
		let matchedPattern: string | null = null;

		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						matchedPattern = zap;
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		const inputPaths: string[] = [];
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			inputPaths.push(event.input.path);
		} else if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					matchedPattern = zap;
					break;
				}
			}
		}

		// find's required `pattern` is a filename glob (e.g. "*.env") — the `path` check
		// above only sees the search root ("."), so check the pattern too, mirroring grep's glob.
		if (!violationReason && isToolCallEventType("find", event) && event.input.pattern) {
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.pattern.includes(zap) || isPathMatch(event.input.pattern, zap, ctx.cwd)) {
					violationReason = `Find pattern matches zero-access path: ${zap}`;
					matchedPattern = zap;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				for (const rule of rules.bashToolPatterns) {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				}

				if (!violationReason) {
					for (const zap of rules.zeroAccessPaths) {
						if (command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							matchedPattern = zap;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						if (command.includes(rop) && (/[\s>|]/.test(command) || command.includes("rm") || command.includes("mv") || command.includes("sed"))) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
							matchedPattern = rop;
							break;
						}
					}
				}

				if (!violationReason) {
					const hasDeleteOrMove = /\brm\b/.test(command) || /\bmv\b/.test(command);
					if (hasDeleteOrMove) {
						for (const ndp of rules.noDeletePaths) {
							const expanded = expandTilde(ndp);
							const matched = commandReferencesPath(command, ndp) || (expanded !== ndp && commandReferencesPath(command, expanded));
							if (matched) {
								violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
								matchedPattern = ndp;
								break;
							}
						}
					}
				}
			} else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							matchedPattern = rop;
							break;
						}
					}
				}
			}
		}

		if (!violationReason) {
			return { block: false };
		}

		const command = isToolCallEventType("bash", event) ? event.input.command : null;
		const invocation = command ?? JSON.stringify(event.input);

		// ── exemption layer (path categories only) ──
		if (matchedPattern) {
			const exempted = activeExemptions().find((ex) => exemptionApplies(ex, matchedPattern!, inputPaths, command, ctx.cwd));
			if (exempted) {
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "exempted", pattern: exempted.pattern, scope: exempted.scope });
				ctx.ui.notify(`🛡️ Damage-Control: ${event.toolName} allowed by exemption ${exempted.pattern} (${exempted.scope})`, "warning");
				return { block: false };
			}

			if (!deniedThisTurn.has(matchedPattern)) {
				if (ctx.hasUI) {
					// Interactive session: ask the user right now. An approved call
					// proceeds immediately — the agent never sees the block.
					const KEEP = "Keep blocked";
					const ONCE = "Allow once";
					const TURN = "Allow for this turn";
					const SESSION = "Allow for this session";
					const choice = await ctx.ui.select(
						`🛡️ Blocked: ${event.toolName} — ${violationReason}`,
						[KEEP, ONCE, TURN, SESSION],
						{ timeout: PROMPT_TIMEOUT_MS },
					);
					if (choice === ONCE) {
						pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "allowed_once", pattern: matchedPattern });
						return { block: false };
					}
					if (choice === TURN || choice === SESSION) {
						grantExemption(matchedPattern, choice === TURN ? "turn" : "session", "prompt");
						ctx.ui.setStatus("damage-control", statusText());
						return { block: false };
					}
					const note = choice === KEEP
						? `The user reviewed this call and kept the block in place.`
						: `The user did not answer the approval dialog in time (auto-kept blocked). They can pre-authorize with /allow ${matchedPattern} [turn|session].`;
					if (choice === KEEP) deniedThisTurn.add(matchedPattern);
					ctx.ui.setStatus("damage-control", `⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: choice === KEEP ? "blocked_by_user" : "blocked_prompt_timeout" });
					return { block: true, reason: continueFeedback(event.toolName, violationReason, invocation, note) };
				}

				const endpoint = askEndpoint();
				if (endpoint && escalationsThisTurn < MAX_ESCALATIONS_PER_TURN) {
					// Headless child spawned by agent-hub: escalate to the dispatcher
					// and wait for the user's decision (fail closed on timeout/error).
					escalationsThisTurn++;
					const req: AccessRequest = {
						type: "access_request",
						msg_id: crypto.randomUUID(),
						sender_session: agentId(),
						sender_endpoint: "",
						hops: 0,
						timestamp: new Date().toISOString(),
						agent: agentId(),
						tool: event.toolName,
						rule: violationReason,
						pattern: matchedPattern,
						invocation: invocation.slice(0, 500),
					};
					const decision = await requestAccessFromHub(endpoint, req);
					if (decision === "allow_once") {
						pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "allowed_once", pattern: matchedPattern, via: "escalation" });
						return { block: false };
					}
					if (decision === "allow_agent" || decision === "allow_all") {
						// The hub persisted the grant to the shared file; keep a memory
						// copy too so this run doesn't depend on re-reading it.
						sessionExemptions.push({ pattern: matchedPattern, scope: "session", grantedVia: "escalation", grantedAt: new Date().toISOString() });
						pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: decision === "allow_all" ? "allowed_all_agents" : "allowed_this_agent", pattern: matchedPattern, via: "escalation" });
						return { block: false };
					}
					deniedThisTurn.add(matchedPattern);
					const note = decision === "deny"
						? `This block was escalated to the user via the dispatcher and the user DENIED access.`
						: decision === "timeout"
							? `This block was escalated to the user via the dispatcher but the approval request timed out (auto-kept blocked). If access to this path is essential, say so explicitly in your final response so the user can grant it and re-dispatch you.`
							: `Escalating this block to the dispatcher failed (hub unreachable).`;
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: `escalation_${decision}`, pattern: matchedPattern });
					return { block: true, reason: continueFeedback(event.toolName, violationReason, invocation, note) };
				}
			}
		}

		if (shouldAsk) {
			const confirmed = await ctx.ui.confirm(
				"🛡️ Damage-Control Confirmation",
				`Dangerous command detected: ${violationReason}\n\nCommand: ${invocation}\n\nDo you want to proceed?`,
				{ timeout: 30000 },
			);

			if (!confirmed) {
				ctx.ui.setStatus("damage-control", `⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked_by_user" });
				return { block: true, reason: continueFeedback(event.toolName, `${violationReason} (user denied)`, invocation) };
			} else {
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
				return { block: false };
			}
		} else {
			const note = matchedPattern
				? `The user can pre-authorize this path with /allow ${matchedPattern} [turn|session] in a damage-control-continue session.`
				: undefined;
			ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} (${violationReason}) — agent will adapt and continue.`);
			ctx.ui.setStatus("damage-control", `⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
			pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
			return { block: true, reason: continueFeedback(event.toolName, violationReason, invocation, note) };
		}
	});
}
