import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { AF_DEBATE_FAILED_MESSAGE, AF_DEBATE_MESSAGE } from "../debate-command.ts";
import { renderDebateBlock, type DebateBlock } from "../debate-progress.ts";
import { DEBATE_PANEL_DESCRIPTION, DEBATE_PANEL_PARAMETERS, executeDebatePanel, type DebatePanelDeps, type DebatePanelParams } from "./debate-panel-core.ts";

export type { DebatePanelDeps, DebatePanelParams } from "./debate-panel-core.ts";
export { DEBATE_PANEL_ROUNDS, DEBATE_PANEL_SELECT } from "./debate-panel-core.ts";

const AF_DEBATE_WIDGET = "af-debate";

function debateOf(details: unknown): DebateBlock | undefined {
	const debate = (details as { debate?: DebateBlock } | undefined)?.debate;
	return debate && debate.version === 1 && debate.kind === "debate" ? debate : undefined;
}

/** `/af-debate`'s live block: one widget redrawn in place, cleared before the single transcript entry. */
export function debateBlockWidget(ui: ExtensionUIContext): (block: DebateBlock | undefined) => void {
	return block => ui.setWidget(AF_DEBATE_WIDGET, block
		? (_tui, theme) => new Text(renderDebateBlock(block, { expanded: false }, theme).join("\n"), 1, 0)
		: undefined);
}

export function registerDebatePanel(pi: ExtensionAPI, deps: DebatePanelDeps): void {
	pi.registerTool({
		name: "debate_panel",
		label: "Debate Panel",
		description: DEBATE_PANEL_DESCRIPTION,
		parameters: DEBATE_PANEL_PARAMETERS,
		execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			return executeDebatePanel(deps, raw as DebatePanelParams, onUpdate as any, ctx);
		},
		// The panel is named by the result block only after it resolves.
		renderCall(args, theme) {
			const question = String((args as any).question || "");
			const preview = question.length > 60 ? `${question.slice(0, 57)}...` : question;
			return new Text(theme.fg("toolTitle", theme.bold("debate_panel ")) + theme.fg("dim", "— ") + theme.fg("muted", preview), 0, 0);
		},
		renderResult(result, options, theme) {
			const block = debateOf(result.details);
			if (!block) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(renderDebateBlock(block, { expanded: options.expanded }, theme).join("\n"), 0, 0);
		},
	});
	// `/af-debate`'s one outcome entry shows the same block; its content stays the model-facing note.
	for (const customType of [AF_DEBATE_MESSAGE, AF_DEBATE_FAILED_MESSAGE]) {
		pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
			const block = debateOf(message.details);
			if (!block) return undefined;
			const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
			box.addChild(new Text(renderDebateBlock(block, { expanded }, theme).join("\n"), 0, 0));
			return box;
		});
	}
}
