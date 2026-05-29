/**
 * Tool Counter Widget — Tool call counts in a widget above the editor
 *
 * Shows a persistent, live-updating widget with per-tool background colors.
 * Format: Tools (N): [Bash 3] [Read 7] [Write 2]
 *
 * Usage: pi -e extensions/tool-counter-widget.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

const palette = [
	[12, 40, 80],    // deep navy
	[50, 20, 70],    // dark purple
	[10, 55, 45],    // dark teal
	[70, 30, 10],    // dark rust
	[55, 15, 40],    // dark plum
	[15, 50, 65],    // dark ocean
	[45, 45, 15],    // dark olive
	[65, 18, 25],    // dark wine
];

function bg(rgb: number[], s: string): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[49m`;
}

export default function (pi: ExtensionAPI) {
	const counts: Record<string, number> = {};
	const toolColors: Record<string, number[]> = {};
	let total = 0;
	let colorIdx = 0;

	pi.on("tool_execution_end", async (event) => {
		if (!(event.toolName in toolColors)) {
			toolColors[event.toolName] = palette[colorIdx % palette.length];
			colorIdx++;
		}
		counts[event.toolName] = (counts[event.toolName] || 0) + 1;
		total++;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("tool-counter", (_tui, theme) => {
			const text = new Text("", 1, 1);

			return {
				render(width: number): string[] {
					const entries = Object.entries(counts);
					const parts = entries.map(([name, count]) => {
						const rgb = toolColors[name];
						return bg(rgb, `\x1b[38;2;220;220;220m  ${name} ${count}  \x1b[39m`);
					});
					text.setText(
						theme.fg("accent", `Tools (${total}):`) +
						(entries.length > 0 ? " " + parts.join(" ") : "")
					);
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	});
}
