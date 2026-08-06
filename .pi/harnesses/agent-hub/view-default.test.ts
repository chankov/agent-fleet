import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("agent-hub defaults to the compact widget while Fleet Dashboard is a separate overlay", () => {
	assert.match(source, /let viewMode: "compact" \| "off" = "compact";/);
	assert.match(source, /async function openFleetDashboard/);
	assert.match(source, /description: "Open Fleet Dashboard"/);
	const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	assert.match(readme, /Fleet Dashboard and detail/);
});
