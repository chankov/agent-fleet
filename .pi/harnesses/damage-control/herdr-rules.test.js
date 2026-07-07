// Rule-file tests for the herdr fleet verbs in .pi/damage-control-rules.yaml:
// every LLM-reachable destructive herdr method (pane/tab/workspace close,
// server stop/reload, worktree remove) must be caught in both its CLI form
// and as a raw socket call, while read/spawn verbs stay allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// yaml ships in .pi/harnesses/node_modules (the harnesses' runtime deps)
const YAML = require(join(HERE, "..", "node_modules", "yaml"));

const rules = YAML.parse(readFileSync(join(HERE, "..", "..", "damage-control-rules.yaml"), "utf-8"));
const patterns = rules.bashToolPatterns.map((p) => ({ re: new RegExp(p.pattern, "i"), ...p }));

function blocked(cmd) {
	return patterns.some((p) => p.re.test(cmd));
}

test("destructive herdr CLI verbs are blocked", () => {
	for (const cmd of [
		"herdr pane close w1:p2",
		"herdr tab close w1:t1",
		"herdr workspace close w3",
		"herdr server stop",
		"herdr server reload-config",
		"herdr worktree remove ../wt-x",
		"herdr session stop default",
		"herdr session delete old-session",
	]) {
		assert.equal(blocked(cmd), true, `should block: ${cmd}`);
	}
});

test("raw socket calls to destructive herdr methods are blocked", () => {
	for (const method of ["pane.close", "tab.close", "workspace.close", "server.stop", "server.reload_config", "worktree.remove"]) {
		const cmd = `echo '{"id":"x","method":"${method}","params":{}}' | nc -U ~/.config/herdr/herdr.sock`;
		assert.equal(blocked(cmd), true, `should block raw call: ${method}`);
	}
});

test("read/spawn herdr verbs stay allowed", () => {
	for (const cmd of [
		"herdr pane list",
		"herdr pane read w1:p2 --lines 40",
		"herdr pane split w1:p1 --direction right",
		"herdr workspace list",
		"herdr workspace create --label team",
		"herdr agent list",
		"herdr wait agent-status w1:p2 --status done",
		"herdr notification show --title hi",
		"herdr status",
		`echo '{"id":"x","method":"pane.read","params":{}}' | nc -U sock`,
	]) {
		assert.equal(blocked(cmd), false, `should allow: ${cmd}`);
	}
});
