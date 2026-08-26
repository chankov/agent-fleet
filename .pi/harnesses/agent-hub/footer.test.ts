import test from "node:test";
import assert from "node:assert/strict";
import { composeFleetFooterHint, composeHubFooterLeft, renderHubFooterLeft } from "./footer.ts";

// The literal OSC 8 sequence the footer must emit — spelled out rather than
// rebuilt from linkify(), so a change to the link format fails here.
const LINKED = "\x1b]8;;https://github.com/chankov/agent-fleet\x07agent fleet\x1b]8;;\x07";

test("hub footer places the linked version before model and thinking suffix", () => {
	assert.equal(
		composeHubFooterLeft("1.2.3", "gpt-5.5", " (xh)"),
		`${LINKED} v1.2.3 · gpt-5.5 (xh)`,
	);
});

test("fleet footer identifies the dashboard shortcut, work mode, and compact-widget state", () => {
	assert.equal(composeFleetFooterHint("compact"), "Alt+A fleet · Alt+Shift+A widget:compact");
	assert.equal(
		composeFleetFooterHint("compact", "Operator"),
		"Alt+A fleet · Alt+M Operator · Alt+Shift+A widget:compact",
	);
	assert.equal(
		composeFleetFooterHint("off", "Orchestrator"),
		"Alt+A fleet · Alt+M Orchestrator · Alt+Shift+A widget:off",
	);
});

test("hub footer has no dangling version separator when adjacent metadata is unavailable", () => {
	assert.equal(composeHubFooterLeft(null, "gpt-5.5", ""), "gpt-5.5");
});

test("hub footer dims the prepended version and model metadata", () => {
	const calls: Array<[string, string]> = [];
	const theme = {
		fg(color: string, text: string): string {
			calls.push([color, text]);
			return `<${color}>${text}</${color}>`;
		},
	};

	assert.equal(
		renderHubFooterLeft(theme, "1.2.3", "gpt-5.5", " (xh)"),
		`<dim> ${LINKED} v1.2.3 · gpt-5.5 (xh)</dim>`,
	);
	assert.deepEqual(calls, [["dim", ` ${LINKED} v1.2.3 · gpt-5.5 (xh)`]]);
});
