import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");

test("agent-hub starts in compact agent view", () => {
	assert.match(source, /let viewMode: "dashboard" \| "compact" = "compact";/);
	assert.match(readme, /The agent view starts in \*\*compact\*\* mode/);
});
