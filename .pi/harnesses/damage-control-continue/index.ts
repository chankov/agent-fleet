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
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

function continueFeedback(toolName: string, violationReason: string, invocation: string): string {
	return [
		`🛡️ Damage-Control: ${toolName} blocked — ${violationReason}`,
		``,
		`Attempted: ${invocation}`,
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

		const total = rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length;
		ctx.ui.setStatus(`🛡️ Damage-Control (continue): ${total} Rules`);
	});

	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;

		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
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
							break;
						}
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						if (command.includes(rop) && (/[\s>|]/.test(command) || command.includes("rm") || command.includes("mv") || command.includes("sed"))) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
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
							break;
						}
					}
				}
			}
		}

		if (violationReason) {
			const invocation = isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input);

			if (shouldAsk) {
				const confirmed = await ctx.ui.confirm(
					"🛡️ Damage-Control Confirmation",
					`Dangerous command detected: ${violationReason}\n\nCommand: ${invocation}\n\nDo you want to proceed?`,
					{ timeout: 30000 },
				);

				if (!confirmed) {
					ctx.ui.setStatus(`⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked_by_user" });
					return { block: true, reason: continueFeedback(event.toolName, `${violationReason} (user denied)`, invocation) };
				} else {
					pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
					return { block: false };
				}
			} else {
				ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} (${violationReason}) — agent will adapt and continue.`);
				ctx.ui.setStatus(`⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
				return { block: true, reason: continueFeedback(event.toolName, violationReason, invocation) };
			}
		}

		return { block: false };
	});
}
