import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AfPollHandleResult } from "../poll-command.ts";
import { failedPollBlock, pollBlockHeadline, type PollBlock } from "../poll-progress.ts";

export interface PollPanelParams { question: string; panel?: string; persona?: string }

export interface PollPanelDeps {
	/** Runs the same read-only panel poll as `/af-poll`, with typed inputs; each new block snapshot goes to `onProgress`. */
	run(params: PollPanelParams, ctx: ExtensionContext, onProgress: (block: PollBlock) => void): Promise<AfPollHandleResult>;
	/** A refusal that must stop the poll before any model work (roster recovery, capability gate). */
	blocked(ctx: ExtensionContext): string | null;
}

export const POLL_PANEL_DESCRIPTION =
	"Ask the model panel one decision question in parallel; an integrator merges the opinions. For decisions, not facts. Read-only.";
/** Parameter help states the same precedence `/af-poll --panel` uses. */
export const POLL_PANEL_PARAM_HELP = "Panel name. Omitted: configured poll-panel, else the panel named default. Unknown names fail.";
/** How the tool names a panel in selection diagnostics. */
export const POLL_PANEL_SELECT = "panel: \"NAME\"";

type Update = ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void) | undefined;

/**
 * UI-free tool body, so it runs under `node --test` without the TUI package. Every update replaces the
 * previous one with the current block (`details.poll`); the renderer draws it in place.
 */
export async function executePollPanel(deps: PollPanelDeps, params: PollPanelParams, onUpdate: Update, ctx: ExtensionContext) {
	const question = String(params.question ?? "").trim();
	const refusal = deps.blocked(ctx);
	if (refusal) return { content: [{ type: "text" as const, text: refusal }], details: { status: "refused", started: false, poll: failedPollBlock(question, refusal) } };
	const onProgress = (block: PollBlock) => {
		try { onUpdate?.({ content: [{ type: "text", text: pollBlockHeadline(block) }], details: { status: "running", poll: block } }); } catch { /* progress is best-effort */ }
	};
	const result = await deps.run(params, ctx, onProgress);
	if (!result.ok) {
		const poll = result.block ?? failedPollBlock(question, result.message);
		return { content: [{ type: "text" as const, text: `POLL FAILED — no decision was produced.\n\n${result.message}` }], details: { status: "failed", started: Boolean(poll.panel), message: result.message, poll } };
	}
	return { content: [{ type: "text" as const, text: result.dispatcherNote ?? result.message }], details: { status: "ok", started: true, digest: result.digest, poll: result.block } };
}
