import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { executePollPanel, POLL_PANEL_DESCRIPTION, type PollPanelDeps, type PollPanelParams } from "./poll-panel-core.ts";

export type { PollPanelDeps, PollPanelParams } from "./poll-panel-core.ts";

export function registerPollPanel(pi: ExtensionAPI, deps: PollPanelDeps): void {
	pi.registerTool({
		name: "poll_panel",
		label: "Poll Panel",
		description: POLL_PANEL_DESCRIPTION,
		parameters: Type.Object({
			question: Type.String({ minLength: 1, description: "Self-contained English question with options; paths, not bodies." }),
			panel: Type.Optional(Type.String({ description: "voices.yaml panel; default poll-panel." })),
			persona: Type.Optional(Type.String({ description: "Voice persona; default researcher." })),
		}, { additionalProperties: false }),
		execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			return executePollPanel(deps, raw as PollPanelParams, onUpdate as any, ctx);
		},
		renderCall(args, theme) {
			const question = String((args as any).question || "");
			const preview = question.length > 60 ? `${question.slice(0, 57)}...` : question;
			return new Text(
				theme.fg("toolTitle", theme.bold("poll_panel ")) +
				theme.fg("accent", String((args as any).panel || "default")) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
	});
}
