// Publication is a separate explicit permission (PLAN-11-01, task 2): the shipped
// rules turn every publish verb into a one-call human approval (`ask: true`),
// while preparation and inspection commands stay unprompted. Force pushes keep
// their earlier hard denial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const rules = YAML.parse(readFileSync(join(HERE, "..", "..", "damage-control-rules.yaml"), "utf-8"));
const patterns = rules.bashToolPatterns.map((p) => ({ re: new RegExp(p.pattern, "i"), ...p }));
const firstMatch = (cmd) => patterns.find((p) => p.re.test(cmd));

test("publish verbs need a one-call approval", () => {
	for (const cmd of [
		"git push",
		"git push origin main",
		"git push --tags",
		"git push origin v2.3.0",
		"npm publish",
		"npm publish --access public",
		"npm --workspace pkg publish",
		"pnpm publish -r",
		"yarn npm publish",
		"bun publish",
		"npx changeset publish",
		"gh release create v2.3.0 --notes x",
		"gh release upload v2.3.0 dist.tgz",
	]) {
		const rule = firstMatch(cmd);
		assert.ok(rule, `should gate: ${cmd}`);
		assert.equal(rule.ask, true, `should ask, not silently allow: ${cmd}`);
	}
});

test("force pushes stay hard-denied ahead of the publish approval", () => {
	for (const cmd of ["git push --force origin main", "git push -f origin main"]) {
		const rule = firstMatch(cmd);
		assert.ok(rule, cmd);
		assert.notEqual(rule.ask, true, `${cmd} must not become approvable`);
	}
});

test("release preparation and inspection are not gated", () => {
	for (const cmd of [
		"npx changeset version",
		"npx changeset status",
		"npm pack --dry-run",
		"npm test",
		"git status",
		"git log --oneline",
		"git commit -m 'chore: release'",
		"gh release view v2.3.0",
		"gh release list",
	]) {
		assert.equal(firstMatch(cmd), undefined, `should not gate: ${cmd}`);
	}
});
