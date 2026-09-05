import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./ui/fleet-dashboard.ts", import.meta.url), "utf8");
const shortcutSource = readFileSync(new URL("./input/shortcuts.ts", import.meta.url), "utf8");

test("agent-hub opens Fleet Dashboard as a separate overlay without a compact widget", () => {
	assert.doesNotMatch(source, /let viewMode/);
	assert.match(dashboardSource, /async function openFleetDashboard/);
	assert.match(shortcutSource, /description: "Open Fleet Dashboard"/);
	assert.doesNotMatch(shortcutSource, /alt\+shift\+a/);
	const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	assert.match(readme, /Fleet Dashboard and detail/);
});
