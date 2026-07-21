import test from "node:test";
import assert from "node:assert/strict";
import { composeHubFooterLeft, renderHubFooterLeft } from "./footer.ts";

test("hub footer places version before model, thinking suffix, and team", () => {
	assert.equal(
		composeHubFooterLeft("1.2.3", "gpt-5.5", " (xh)", "full"),
		"v1.2.3 · gpt-5.5 (xh) · full",
	);
});

test("hub footer has no dangling version separator when adjacent metadata is unavailable", () => {
	assert.equal(composeHubFooterLeft(null, "gpt-5.5", "", "full"), "gpt-5.5 · full");
});

test("hub footer keeps the active team accent while dimming the prepended version and model", () => {
	const calls: Array<[string, string]> = [];
	const theme = {
		fg(color: string, text: string): string {
			calls.push([color, text]);
			return `<${color}>${text}</${color}>`;
		},
	};

	assert.equal(
		renderHubFooterLeft(theme, "1.2.3", "gpt-5.5", " (xh)", "full"),
		"<dim> v1.2.3 · gpt-5.5 (xh)</dim><muted> · </muted><accent>full</accent>",
	);
	assert.deepEqual(calls, [
		["dim", " v1.2.3 · gpt-5.5 (xh)"],
		["muted", " · "],
		["accent", "full"],
	]);
});
