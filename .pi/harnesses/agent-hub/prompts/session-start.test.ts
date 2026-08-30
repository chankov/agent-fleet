import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildSessionStartNotice, createSessionFooter } from "./session-start.ts";

const noticeData = {
	workMode: "orchestrator",
	activeTeamName: "Default",
	agentCount: 2,
	members: "Builder, Verifier",
	dispatchLabel: "all native (no substitutions in .pi/agents/dispatch-policy.yaml)",
	userLanguage: "English",
	askUserLabel: "available (via pi-ask-user)",
	comsLabel: "off (--solo: fixed specialists + research only)",
	fleetLabel: "off (not inside a herdr pane, or no herdr server)",
};

test("session-start notice remains an exact data-oriented template", () => {
	const notice = buildSessionStartNotice(noticeData);
	assert.equal(createHash("sha256").update(notice).digest("hex"), "73ebf953741f3f767eb54e4458ce61542cc2951bd803c8d519a0fdf3fc0b3d77");
	assert.match(notice, /^Work Mode: orchestrator \(delegate-only\)/);
	assert.match(notice, /\/af-compound \[focus\].*project rules\/docs$/);
});

test("footer uses the injected dispatcher thinking formatter without changing its suffix", () => {
	const footer = createSessionFooter({
		ctx: { getContextUsage: () => ({ percent: 42 }) } as never,
		version: "v1",
		getModel: () => "model",
		getThinkingLevel: () => "high",
		thinkingSuffix: value => value === "high" ? " (high)" : "",
		getHint: () => "Alt+A fleet",
		renderLeft: (_theme, version, model, thinking) => `${version} | ${model}${thinking}`,
		truncateToWidth: value => value,
		visibleWidth: value => value.length,
	});
	const theme = { fg: (_color: string, text: string) => text } as never;
	assert.equal(footer({}, theme, undefined).render(80)[0]?.startsWith("v1 | model (high)"), true);
});
