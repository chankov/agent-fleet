import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { composeFleetFooterHint, renderHubFooterLeft } from "../footer.ts";
import { HARNESS_VERSION } from "../version.ts";

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
	assert.equal(createHash("sha256").update(notice).digest("hex"), "088a8c0422d5cff085e66f58a75c30a098e54ca9de4a2bd339545aec4b648877");
	assert.match(notice, /^Work Mode: orchestrator \(delegate-only\)/);
	assert.match(notice, /\/af-poll \[--panel NAME\].*same question/);
	assert.match(notice, /\/af-debate \[--panel NAME\].*model panel$/);
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

function productionFooter(ctx: { model?: { provider: string; id: string }; getContextUsage(): { percent: number } }) {
	// Exercise the actual wiring expression without loading the entire live Hub.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const getter = source.slice(source.indexOf("installFooter: (_ctx)")).match(/getModel:\s*(\(\) => [^\n]+),/);
	assert.ok(getter, "production footer model getter must be present");
	const getModel = runInNewContext(`(${getter[1]})`, { _ctx: ctx }) as () => string;
	let thinking: string | undefined = "medium";
	const factory = createSessionFooter({
		ctx: ctx as never, version: HARNESS_VERSION ?? "unknown", getModel,
		getThinkingLevel: () => thinking, thinkingSuffix: value => value === "medium" ? " (med)" : "",
		getHint: () => composeFleetFooterHint("Operator"), renderLeft: renderHubFooterLeft, truncateToWidth, visibleWidth,
	});
	const theme = { fg: (_color: string, text: string) => text } as never;
	return { footer: factory({}, theme, { getExtensionStatuses: () => new Map([["voice-stt", "REC microphone"]]) }), off: () => { thinking = "off"; } };
}

test("production footer reads the current provider and full model ID on each render", () => {
	const ctx = { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, getContextUsage: () => ({ percent: 42 }) };
	const { footer, off } = productionFooter(ctx);
	assert.match(footer.render(200)[0], /agent fleet.* · openai-codex\/gpt-6\.1-sol \(med\)/);
	ctx.model = { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" };
	assert.match(footer.render(200)[0], / · openrouter\/anthropic\/claude-sonnet-4\.5 \(med\)/);
	off();
	assert.match(footer.render(200)[0], /openrouter\/anthropic\/claude-sonnet-4\.5 {2,}Alt\+A fleet/);
	assert.ok(!footer.render(200)[0].includes("(med)"));
	assert.match(footer.render(200)[0], /Alt\+A fleet · Alt\+I inspect · Alt\+M Operator/);
	assert.match(footer.render(200)[0], /\[####------\] 42%/);
	assert.equal(footer.render(200)[1], " REC microphone");
});

test("production footer retains no-model fallback and existing narrow-width truncation", () => {
	const ctx: { model?: { provider: string; id: string }; getContextUsage(): { percent: number } } = { getContextUsage: () => ({ percent: 42 }) };
	const { footer } = productionFooter(ctx);
	assert.match(footer.render(200)[0], / · no-model \(med\)/);
	ctx.model = { provider: "openrouter", id: "organization/very-long-model-identifier" };
	for (const width of [1, 12, 40, 80, 200]) {
		const lines = footer.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
	}
});
