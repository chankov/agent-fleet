/**
 * delegate — the injected extension that gives an agent-hub specialist a
 * mid-turn `delegate(role, instruction, context?, allow_write?)` tool.
 *
 * The hub adds `-e delegate.ts` (plus `delegate` in the child's `--tools`
 * allowlist — pi's allowlist applies to extension tools too) when a dispatched
 * persona declares `subagents:` in its frontmatter. Everything this extension
 * may spawn comes from AGENT_HUB_DELEGATE_CONFIG (JSON, serialized by the
 * hub): the declared sub-roles and their models, the remaining depth budget,
 * the call budget, and the event directory. The child process NEVER re-parses
 * persona files — model choice is configuration, not the LLM's whim.
 *
 * Budgets (readable refusals, never silent):
 *   - call budget: at most `callBudget` delegate calls per dispatch (default 6)
 *   - depth budget: each child receives `depth − 1`; at 0 the tool exists but
 *     refuses, so a persona with `delegate_depth: 1` (the default) can spawn
 *     children that cannot delegate further
 *
 * Write safety: a child is read-only (read,grep,find,ls) unless it is the ONLY
 * live child and the parent passed `allow_write: true` — then it inherits the
 * parent's tools, intersected with the role's declared `tools:` cap when one
 * exists. Concurrent children are always forced read-only (two agents editing
 * the same files is not solvable with guardrails).
 *
 * Observability: every spawn/timeline/usage/exit is appended as JSONL to
 * `<eventDir>/events.jsonl`. The hub watches that file and renders children as
 * nested rows under the parent's grid card (openable via /zoom). Kill cascade:
 * children are spawned in THIS process's group (the hub spawns specialists
 * detached), so `/agents-kill` on the parent SIGTERMs the whole tree; a
 * SIGTERM trap forwards to live children as a fallback.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ChildProcess } from "child_process";
import { spawnPiAgent } from "./spawn.ts";

const READ_ONLY_TOOLS = "read,grep,find,ls";
const DEFAULT_CALL_BUDGET = 6;
const RESULT_CAP = 8000;
// How often buffered text/thinking deltas are flushed into the event file.
const TIMELINE_FLUSH_MS = 700;

// Serialized by the hub into AGENT_HUB_DELEGATE_CONFIG. `tag` is this
// process's node id in the delegation tree ("root" for the specialist itself);
// nested delegate.ts instances get their child id as tag, so every event line
// carries an unambiguous parent chain.
export interface DelegateConfig {
	persona: string;
	tag: string;
	roles: Record<string, { model: string; tools?: string }>;
	depth: number;
	callBudget: number;
	parentTools: string;
	personaPrompt: string;
	eventDir: string;
	damageControl?: string;
	delegateExt: string;
	cwd: string;
}

// Appended to every child's system prompt so it knows its place in the tree
// and reports tersely (its full report returns through the tool result, which
// lands in the parent's context).
function subagentProtocol(persona: string, role: string, canDelegate: boolean): string {
	return `

## You are the "${role}" sub-agent of a ${persona} specialist
Your parent delegated ONE specific task to you. Do exactly that task — do not
widen scope, do not start unrelated work. Report your findings/result concisely
and concretely (cite locations as path:line where relevant); your final message
is returned to your parent verbatim, so make it self-contained.${canDelegate ? `
You may delegate narrow sub-tasks further via your own delegate tool, within
its declared roles and budgets.` : `
You CANNOT delegate further — your depth budget is exhausted. Do the work
yourself with the tools you have.`}`;
}

// Intersect two comma-separated tool lists, preserving the cap's order.
function intersectTools(base: string, cap: string): string {
	const baseSet = new Set(base.split(",").map(s => s.trim()).filter(Boolean));
	return cap.split(",").map(s => s.trim()).filter(t => t && baseSet.has(t)).join(",");
}

export default function (pi: ExtensionAPI) {
	let cfg: DelegateConfig | null = null;
	try {
		cfg = JSON.parse(process.env.AGENT_HUB_DELEGATE_CONFIG || "");
	} catch {
		cfg = null;
	}
	// Misconfigured (or launched outside the hub): register nothing — the
	// parent simply has no delegate tool.
	if (!cfg || !cfg.roles || !cfg.eventDir) return;
	const config = cfg;
	config.callBudget = config.callBudget > 0 ? config.callBudget : DEFAULT_CALL_BUDGET;

	let callCount = 0;
	let childSeq = 0;
	// Synchronous reservation counter for the write-safety gate. Incremented at
	// the gate (before any await), so two parallel delegate calls can never both
	// observe "I am the only child" — do NOT replace this with liveChildren.size,
	// which only grows once the child process actually spawns.
	let liveCount = 0;
	const liveChildren = new Set<ChildProcess>();

	// Fallback cascade: the primary kill path is the process group (the hub
	// signals the specialist's negative PID), but if only this process is
	// terminated, forward the signal to any live children.
	process.on("SIGTERM", () => {
		for (const child of liveChildren) {
			try { child.kill("SIGTERM"); } catch {}
		}
	});

	const emit = (event: Record<string, unknown>) => {
		try {
			appendFileSync(join(config.eventDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
		} catch {}
	};

	const roleNames = Object.keys(config.roles);

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			`Spawn one of your declared sub-agents on its pre-configured model and wait for its report. ` +
			`Declared roles: ${roleNames.join(", ")}. Use it to fan out scoped sub-tasks (reviews, scans, ` +
			`doc checks) instead of doing everything yourself; you may run several delegate calls in ` +
			`parallel, but parallel children are forced read-only. The child does not share your context — ` +
			`pass everything it needs in \`instruction\`/\`context\`.`,
		parameters: Type.Object({
			role: Type.String({ description: `Declared sub-role to spawn. One of: ${roleNames.join(", ")}` }),
			instruction: Type.String({ description: "The specific, self-contained task for the sub-agent." }),
			context: Type.Optional(Type.String({
				description: "Optional background brief pasted above the instruction (the child shares none of " +
					"your context). The keyword 'fork' (full context fork) is accepted but treated as a summary " +
					"brief in v1 — write the brief out.",
			})),
			allow_write: Type.Optional(Type.Boolean({
				description: "Let the child inherit your tools (including write access). Honored only while it " +
					"is your ONLY live child; concurrent children are always read-only. A role-level tools cap " +
					"still wins.",
			})),
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			const { role, instruction, context, allow_write } = params as {
				role: string; instruction: string; context?: string; allow_write?: boolean;
			};

			// Readable refusals — budget exhaustion is an answer, not a mystery.
			if (config.depth <= 0) {
				return {
					content: [{ type: "text" as const, text:
						`Delegation refused: your depth budget is 0 — you are already at the bottom of the ` +
						`delegation tree. Do this task yourself with your own tools.` }],
				};
			}
			if (callCount >= config.callBudget) {
				return {
					content: [{ type: "text" as const, text:
						`Delegation refused: call budget exhausted (${config.callBudget} delegate calls per ` +
						`dispatch). Finish with the results you already have.` }],
				};
			}
			const roleKey = roleNames.find(r => r.toLowerCase() === role.toLowerCase());
			if (!roleKey) {
				return {
					content: [{ type: "text" as const, text:
						`Delegation refused: "${role}" is not a declared sub-role. Declared roles: ` +
						`${roleNames.join(", ")}.` }],
				};
			}
			const roleDef = config.roles[roleKey];

			callCount++;
			childSeq++;
			const childId = config.tag === "root" ? `${roleKey}-${childSeq}` : `${config.tag}.${roleKey}-${childSeq}`;

			// Write safety: read-only unless this is the only live child AND the
			// parent explicitly granted write. The role's tools cap always wins.
			const concurrent = liveCount > 0;
			liveCount++;
			const wantedWrite = allow_write === true;
			const base = wantedWrite && !concurrent ? config.parentTools : READ_ONLY_TOOLS;
			let effectiveTools = roleDef.tools ? intersectTools(base, roleDef.tools) : base;
			if (!effectiveTools) effectiveTools = READ_ONLY_TOOLS;
			const writeDowngraded = wantedWrite && concurrent;

			// A child with remaining depth gets its own delegate tool (and the
			// tool's name in its allowlist — pi filters extension tools too).
			const childDepth = config.depth - 1;
			const childCanDelegate = childDepth > 0;
			const childExtensions = [
				...(config.damageControl ? [config.damageControl] : []),
				...(childCanDelegate ? [config.delegateExt] : []),
			];
			const childTools = childCanDelegate ? `${effectiveTools},delegate` : effectiveTools;
			const childConfig: DelegateConfig = {
				...config,
				tag: childId,
				depth: childDepth,
				parentTools: effectiveTools,
			};

			const sessionsDir = join(config.eventDir, "sessions");
			try { mkdirSync(sessionsDir, { recursive: true }); } catch {}

			emit({
				t: "spawn", id: childId, parent: config.tag, role: roleKey,
				model: roleDef.model, tools: effectiveTools, ts: Date.now(),
			});
			onUpdate?.({
				content: [{ type: "text", text: `Delegating to ${roleKey} (${roleDef.model})...` }],
				details: { id: childId, role: roleKey, model: roleDef.model, status: "running" },
			});

			// Buffered timeline streaming: coalesce text/thinking deltas and flush
			// them into the event file on an interval (and on tool/exit), so the
			// hub can render a live /zoom timeline without an event per token.
			let pendingKind: "text" | "thinking" | null = null;
			let pendingDelta = "";
			const flushTimeline = () => {
				if (!pendingKind || !pendingDelta) return;
				emit({ t: "timeline", id: childId, kind: pendingKind, delta: pendingDelta });
				pendingDelta = "";
			};
			const queueDelta = (kind: "text" | "thinking", delta: string) => {
				if (pendingKind !== kind) flushTimeline();
				pendingKind = kind;
				pendingDelta += delta;
			};
			const flushTimer = setInterval(flushTimeline, TIMELINE_FLUSH_MS);

			const startTime = Date.now();
			let childProc: ChildProcess | null = null;
			const mode = context?.trim().toLowerCase();
			const brief = context && mode !== "summary" && mode !== "fork" ? context : undefined;
			const prompt = brief
				? `## Context from your parent\n${brief}\n\n## Your task\n${instruction}`
				: instruction;

			let res;
			try {
				res = await spawnPiAgent({
					model: roleDef.model,
					tools: childTools,
					thinking: "off",
					appendSystemPrompt: config.personaPrompt + subagentProtocol(config.persona, roleKey, childCanDelegate),
					sessionFile: join(sessionsDir, `${childId}.jsonl`),
					prompt,
					extensions: childExtensions,
					env: { AGENT_HUB_DELEGATE_CONFIG: JSON.stringify(childConfig) },
					cwd: config.cwd,
				}, {
					onProcess: (p) => { childProc = p; liveChildren.add(p); },
					onTextDelta: (delta) => queueDelta("text", delta),
					onThinkingDelta: (delta) => queueDelta("thinking", delta),
					onToolStart: (toolName, argStr) => {
						flushTimeline();
						emit({ t: "tool", id: childId, name: toolName, args: argStr.slice(0, 500) });
					},
					onUsage: (usage, source) => {
						if (source === "message_end") {
							emit({ t: "usage", id: childId, input: usage.input || 0, output: usage.output || 0 });
						}
					},
				});
			} finally {
				liveCount--;
				clearInterval(flushTimer);
				if (childProc) liveChildren.delete(childProc);
			}

			flushTimeline();
			const elapsed = Date.now() - startTime;
			const code = res.spawnError ? 1 : (res.exitCode ?? 1);
			emit({ t: "exit", id: childId, code, elapsed, ts: Date.now() });

			if (res.spawnError) {
				return {
					content: [{ type: "text" as const, text: `Delegate ${childId} failed to spawn: ${res.spawnError}` }],
					details: { id: childId, role: roleKey, status: "error" },
				};
			}

			let output = res.output;
			if (code !== 0) {
				const errTail = res.stderr.trim().slice(-1000);
				output = output
					? `${output}\n\n[stderr]\n${errTail}`
					: `Delegate ${childId} exited with code ${code} and produced no output.\n\n[stderr]\n${errTail}`;
			}
			if (output.length > RESULT_CAP) {
				output = output.slice(0, RESULT_CAP) + "\n\n... [truncated]";
			}

			const notes: string[] = [];
			if (writeDowngraded) notes.push("allow_write ignored — other children were live, so it ran read-only");
			if (mode === "fork") notes.push("context: fork is not supported in v1 — the child started fresh from your instruction");
			const noteBlock = notes.length > 0 ? `\n[note: ${notes.join("; ")}]` : "";

			return {
				content: [{ type: "text" as const, text:
					`[delegate ${childId} · ${roleDef.model} · ${effectiveTools}] ${code === 0 ? "done" : "error"} ` +
					`in ${Math.round(elapsed / 1000)}s${noteBlock}\n\n${output}` }],
				details: { id: childId, role: roleKey, model: roleDef.model, status: code === 0 ? "done" : "error", elapsed },
			};
		},
	});
}
