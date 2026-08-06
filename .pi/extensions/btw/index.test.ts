import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("btw is a shared fullscreen capturing panel with focus and cleanup", () => {
	assert.match(source, /from "\.\.\/\.\.\/harnesses\/lib\/fleet-overlay\.ts"/);
	assert.match(source, /from "\.\.\/\.\.\/harnesses\/lib\/fleet-panel\.ts"/);
	assert.match(source, /const BTW_CHROME_ROWS = 6/);
	assert.match(source, /class BtwPanel/);
	assert.doesNotMatch(source, /nonCapturing/);
	assert.match(source, /\{ \.\.\.FULLSCREEN_OVERLAY, onHandle: \(h\) => h\.focus\(\) \}/);
	assert.match(source, /panel\.render\(w, tui\.terminal\?\.rows, theme as Theme\)/);
	assert.match(source, /const composerLines = this\.input\.render\(width\)/);
	assert.match(source, /const transcriptHeight = Math\.max\(0, this\.contentHeight - Math\.max\(0, composerLines\.length - 1\)\)/);
	assert.match(source, /fitToHeight\(lines, this\.contentHeight \+ BTW_CHROME_ROWS\)/);
	assert.match(source, /resources\.every\(500, \(\) => tui\.requestRender\(\)\)/);
	assert.match(source, /Esc return to main \(task keeps running\)/);
	assert.match(source, /this\.input\.focused = true/);
	assert.match(source, /this\.input\.handleInput\(data\)/);
	assert.match(source, /matchesKey\(data, Key\.left\)/);
	assert.match(source, /matchesKey\(data, Key\.right\)/);
	assert.match(source, /this\.close\(\)/);
	assert.match(source, /currentPanel = \{/);
	assert.match(source, /panel\.show\(id\)/);
	assert.match(source, /Key\.ctrl\("c"\)/);
	assert.match(source, /t\.session\.prompt\(text/);
});
