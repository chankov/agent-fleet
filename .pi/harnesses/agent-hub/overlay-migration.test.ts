import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("zoom and history use shared fullscreen geometry and disposable panel resources", () => {
	assert.match(source, /import \{ FULLSCREEN_OVERLAY, bodyRows, clampScroll, fitToHeight \} from "\.\.\/lib\/fleet-overlay\.ts"/);
	assert.match(source, /import \{ createPanelResources \} from "\.\.\/lib\/fleet-panel\.ts"/);
	assert.match(source, /const ZOOM_CHROME_ROWS = 5/);
	assert.match(source, /const HISTORY_CHROME_ROWS = 6/);
	assert.match(source, /ui\.render\(w, bodyRows\(tui\.terminal\?\.rows, ZOOM_CHROME_ROWS\), theme\)/);
	assert.match(source, /ui\.render\(w, bodyRows\(tui\.terminal\?\.rows, HISTORY_CHROME_ROWS\), theme\)/);
	assert.match(source, /\}, FULLSCREEN_OVERLAY\);/);
	assert.match(source, /resources\.every\(1000, \(\) => tui\.requestRender\(\)\)/);
	assert.match(source, /dispose: \(\) => resources\.dispose\(\)/);
	assert.match(source, /const bodyHeight = Math\.max\(0, contentHeight \+ ZOOM_CHROME_ROWS - topLines\.length - bottomLines\.length\)/);
	assert.match(source, /const bodyHeight = Math\.max\(0, contentHeight \+ HISTORY_CHROME_ROWS - topLines\.length - bottomLines\.length\)/);
	assert.match(source, /fitToHeight\(\[\.\.\.topLines, \.\.\.fitToHeight\(bodyLines, bodyHeight\), \.\.\.bottomLines\], contentHeight \+ ZOOM_CHROME_ROWS\)/);
	assert.match(source, /fitToHeight\(\[\.\.\.topLines, \.\.\.fitToHeight\(bodyLines, bodyHeight\), \.\.\.bottomLines\], contentHeight \+ HISTORY_CHROME_ROWS\)/);
});
