import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createExecutionHistoryStore } from "./ui/history-store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const zoomSource = readFileSync(new URL("./ui/zoom.ts", import.meta.url), "utf8");
const historySource = readFileSync(new URL("./ui/history.ts", import.meta.url), "utf8");

test("zoom and history use shared fullscreen geometry and disposable panel resources", () => {
	assert.match(source, /import \{ openZoom, type TimelineEntry, type Zoomable \} from "\.\/ui\/zoom\.ts"/);
	assert.match(source, /import \{ openHistory \} from "\.\/ui\/history\.ts"/);
	for (const overlaySource of [zoomSource, historySource]) {
		assert.match(overlaySource, /import \{ FULLSCREEN_OVERLAY, bodyRows, fitToHeight \} from "\.\.\/\.\.\/lib\/fleet-overlay\.ts"/);
		assert.match(overlaySource, /import \{ createPanelResources \} from "\.\.\/\.\.\/lib\/fleet-panel\.ts"/);
		assert.match(overlaySource, /\}, FULLSCREEN_OVERLAY\);/);
		assert.match(overlaySource, /dispose: \(\) => resources\.dispose\(\)/);
	}
	assert.match(zoomSource, /export const ZOOM_CHROME_ROWS = 5/);
	assert.match(historySource, /export const HISTORY_CHROME_ROWS = 6/);
	assert.match(zoomSource, /ui\.render\(w, bodyRows\(tui\.terminal\?\.rows, ZOOM_CHROME_ROWS\), theme\)/);
	assert.match(historySource, /ui\.render\(w, bodyRows\(tui\.terminal\?\.rows, HISTORY_CHROME_ROWS\), theme\)/);
	assert.match(historySource, /resources\.every\(1000, \(\) => tui\.requestRender\(\)\)/);
	assert.match(historySource, /resources\.onDispose\(store\.onChange\(\(\) => tui\.requestRender\(\)\)\)/);
	assert.match(zoomSource, /const bodyHeight = Math\.max\(0, contentHeight \+ ZOOM_CHROME_ROWS - topLines\.length - bottomLines\.length\)/);
	assert.match(historySource, /const bodyHeight = Math\.max\(0, contentHeight \+ HISTORY_CHROME_ROWS - topLines\.length - bottomLines\.length\)/);
	assert.match(zoomSource, /fitToHeight\(\[\.\.\.topLines, \.\.\.fitToHeight\(bodyLines, bodyHeight\), \.\.\.bottomLines\], contentHeight \+ ZOOM_CHROME_ROWS\)/);
	assert.match(historySource, /fitToHeight\(\[\.\.\.topLines, \.\.\.fitToHeight\(bodyLines, bodyHeight\), \.\.\.bottomLines\], contentHeight \+ HISTORY_CHROME_ROWS\)/);
});

test("execution history store owns turn, nesting, ask-user, reset, and change tracking", () => {
	let now = 100;
	const store = createExecutionHistoryStore(() => now);
	let changes = 0;
	const unsubscribe = store.onChange(() => changes++);
	store.startTurn();
	store.startAskUser("ask", 110);
	assert.equal(store.openAskUserWaitMs(125), 15);
	assert.equal(store.endAskUser("ask", 130), 20);
	const agent = store.start("agent", "Builder", { startedAt: 140 });
	const delegate = store.start("delegate", "Verifier", { parent: agent, startedAt: 150 });
	store.end(agent, "done", 200);
	store.endTurn(210);
	const [dispatcher] = store.entries();
	assert.deepEqual(dispatcher.awaitIntervals, [[110, 130]]);
	assert.equal(agent.parent, dispatcher);
	assert.equal(delegate.endedAt, 200);
	assert.equal(delegate.status, "done");
	assert.ok(changes >= 5);
	unsubscribe();
	const before = changes;
	store.reset();
	assert.deepEqual(store.entries(), []);
	assert.equal(store.turnStartedAt(), 0);
	assert.equal(changes, before);
});
