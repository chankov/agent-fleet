import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AfDebateHandleResult } from "../debate-command.ts";
import { debateBlockHeadline, failedDebateBlock, type DebateBlock } from "../debate-progress.ts";

export interface DebatePanelParams { question: string; panel?: string; persona?: string; rounds?: number }

export interface DebatePanelDeps {
	/** Runs the same read-only debate as `/af-debate`, with typed inputs; each new block snapshot goes to `onProgress`. */
	run(params: DebatePanelParams, ctx: ExtensionContext, onProgress: (block: DebateBlock) => void): Promise<AfDebateHandleResult>;
	/** A refusal that must stop the debate before any model work (roster recovery, capability gate). */
	blocked(ctx: ExtensionContext): string | null;
}

export const DEBATE_PANEL_DESCRIPTION =
	"Cross-examine one decision across the model panel for 2–5 rounds; voices answer each other. Read-only; no judge.";
/** The typed inputs; the round range and persona are checked by the shared runner, with one actionable refusal. */
export const DEBATE_PANEL_PARAMETERS = Type.Object({
	question: Type.String({ minLength: 1, description: "Decision, options, objection to test, evidence paths." }),
	panel: Type.Optional(Type.String({ description: "As in poll_panel." })),
	persona: Type.Optional(Type.String({ description: "researcher (default) | reviewer" })),
	rounds: Type.Optional(Type.Integer({ description: "2–5; default 3." })),
}, { additionalProperties: false });

/** How the tool names its inputs in diagnostics. */
export const DEBATE_PANEL_SELECT = "panel: \"NAME\"";
export const DEBATE_PANEL_ROUNDS = "rounds: 2–5";

type Update = ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void) | undefined;

/**
 * UI-free tool body, so it runs under `node --test` without the TUI package. Every update replaces the
 * previous one with the current block (`details.debate`); the renderer draws it in place.
 */
export async function executeDebatePanel(deps: DebatePanelDeps, params: DebatePanelParams, onUpdate: Update, ctx: ExtensionContext) {
	const question = String(params.question ?? "").trim();
	const refusal = deps.blocked(ctx);
	if (refusal) return { content: [{ type: "text" as const, text: refusal }], details: { status: "refused", started: false, debate: failedDebateBlock(question, refusal) } };
	const onProgress = (block: DebateBlock) => {
		try { onUpdate?.({ content: [{ type: "text", text: debateBlockHeadline(block) }], details: { status: "running", debate: block } }); } catch { /* progress is best-effort */ }
	};
	const result = await deps.run(params, ctx, onProgress);
	if (!result.ok) {
		const debate = result.block ?? failedDebateBlock(question, result.message);
		return { content: [{ type: "text" as const, text: `DEBATE FAILED — no positions were produced for a decision.\n\n${result.message}` }], details: { status: "failed", started: Boolean(debate.panel), message: result.message, debate } };
	}
	return { content: [{ type: "text" as const, text: result.dispatcherNote ?? result.message }], details: { status: "ok", started: true, digest: result.digest, result: result.result, debate: result.block } };
}
