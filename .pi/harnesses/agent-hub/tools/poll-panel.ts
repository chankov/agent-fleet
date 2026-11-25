import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text } from "@mariozechner/pi-tui";
import { AF_POLL_FAILED_MESSAGE, AF_POLL_MESSAGE } from "../poll-command.ts";
import { renderPollBlock, type PollBlock } from "../poll-progress.ts";
import { executePollPanel, POLL_PANEL_DESCRIPTION, POLL_PANEL_PARAM_HELP, type PollPanelDeps, type PollPanelParams } from "./poll-panel-core.ts";

export type { PollPanelDeps, PollPanelParams } from "./poll-panel-core.ts";
export { POLL_PANEL_SELECT } from "./poll-panel-core.ts";

const AF_POLL_WIDGET = "af-poll";

function pollOf(details: unknown): PollBlock | undefined {
	const poll = (details as { poll?: PollBlock } | undefined)?.poll;
	return poll && poll.version === 1 ? poll : undefined;
}

/** `/af-poll`'s live block: one widget redrawn in place, cleared before the single transcript entry. */
export function pollBlockWidget(ui: ExtensionUIContext): (block: PollBlock | undefined) => void {
	return block => ui.setWidget(AF_POLL_WIDGET, block
		? (_tui, theme) => new Text(renderPollBlock(block, { expanded: false }, theme).join("\n"), 1, 0)
		: undefined);
}

export function registerPollPanel(pi: ExtensionAPI, deps: PollPanelDeps): void {
	pi.registerTool({
		name: "poll_panel",
		label: "Poll Panel",
		description: POLL_PANEL_DESCRIPTION,
		parameters: Type.Object({
			question: Type.String({ minLength: 1, description: "Self-contained English question with options; paths, not bodies." }),
			panel: Type.Optional(Type.String({ description: POLL_PANEL_PARAM_HELP })),
			persona: Type.Optional(Type.String({ description: "Voice persona; default researcher." })),
		}, { additionalProperties: false }),
		execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			return executePollPanel(deps, raw as PollPanelParams, onUpdate as any, ctx);
		},
		// The panel is named by the result block only after it resolves.
		renderCall(args, theme) {
			const question = String((args as any).question || "");
			const preview = question.length > 60 ? `${question.slice(0, 57)}...` : question;
			return new Text(theme.fg("toolTitle", theme.bold("poll_panel ")) + theme.fg("dim", "— ") + theme.fg("muted", preview), 0, 0);
		},
		renderResult(result, options, theme) {
			const block = pollOf(result.details);
			if (!block) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(renderPollBlock(block, { expanded: options.expanded }, theme).join("\n"), 0, 0);
		},
	});
	// `/af-poll`'s one outcome entry shows the same block; its content stays the model-facing note.
	for (const customType of [AF_POLL_MESSAGE, AF_POLL_FAILED_MESSAGE]) {
		pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
			const block = pollOf(message.details);
			if (!block) return undefined;
			const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
			box.addChild(new Text(renderPollBlock(block, { expanded }, theme).join("\n"), 0, 0));
			return box;
		});
	}
}
