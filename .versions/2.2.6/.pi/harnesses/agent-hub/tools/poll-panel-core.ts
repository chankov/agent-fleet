import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AfPollHandleResult } from "../poll-command.ts";

export interface PollPanelParams { question: string; panel?: string; persona?: string }

export interface PollPanelDeps {
	/** Runs the same read-only panel poll as `/af-poll`, with typed inputs. */
	run(params: PollPanelParams, ctx: ExtensionContext, onProgress: (line: string) => void): Promise<AfPollHandleResult>;
	/** A refusal that must stop the poll before any model work (roster recovery, capability gate). */
	blocked(ctx: ExtensionContext): string | null;
}

export const POLL_PANEL_DESCRIPTION =
	"Ask the model panel one decision question in parallel; an integrator merges the opinions. For decisions, not facts. Read-only.";

type Update = ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void) | undefined;

/** UI-free tool body, so it runs under `node --test` without the TUI package. */
export async function executePollPanel(deps: PollPanelDeps, params: PollPanelParams, onUpdate: Update, ctx: ExtensionContext) {
	const refusal = deps.blocked(ctx);
	if (refusal) return { content: [{ type: "text" as const, text: refusal }], details: { status: "refused", started: false } };
	const progress: string[] = [];
	const onProgress = (line: string) => {
		progress.push(line);
		try { onUpdate?.({ content: [{ type: "text", text: progress.join("\n\n") }], details: { status: "running" } }); } catch { /* progress is best-effort */ }
	};
	const result = await deps.run(params, ctx, onProgress);
	if (!result.ok) return { content: [{ type: "text" as const, text: `POLL FAILED — no decision was produced.\n\n${result.message}` }], details: { status: "failed", started: true, message: result.message } };
	return { content: [{ type: "text" as const, text: result.dispatcherNote ?? result.message }], details: { status: "ok", started: true, digest: result.digest } };
}
