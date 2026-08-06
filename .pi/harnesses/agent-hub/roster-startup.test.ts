import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { orchestratorNeedsRoster, resolveStartupRoster } from "./helpers.ts";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("startup roster is empty unless a team is explicitly requested", () => {
	const teams = { default: ["builder"], Frontend: ["frontend-engineer", "test-engineer"] };
	assert.equal(resolveStartupRoster(teams, undefined), null);
	assert.equal(resolveStartupRoster(teams, ""), null);
	assert.equal(resolveStartupRoster(teams, "   "), null);
});

test("startup roster resolves a named team case-insensitively and preserves its declared name", () => {
	const teams = { default: ["builder"], Frontend: ["frontend-engineer", "test-engineer"] };
	assert.deepEqual(resolveStartupRoster(teams, "frontend"), {
		name: "Frontend",
		members: ["frontend-engineer", "test-engineer"],
	});
});

test("unknown startup roster refuses with available team names", () => {
	assert.throws(
		() => resolveStartupRoster({ default: ["builder"], security: ["security-auditor"] }, "missing"),
		/Unknown native roster "missing".*default, security/,
	);
});

test("orchestrator posture cannot be entered or left with an empty roster", () => {
	assert.equal(orchestratorNeedsRoster("operator", 0), false);
	assert.equal(orchestratorNeedsRoster("operator", 1), false);
	assert.equal(orchestratorNeedsRoster("orchestrator", 0), true);
	assert.equal(orchestratorNeedsRoster("orchestrator", 1), false);
});

test("Hub wires explicit startup roster without falling back to the first YAML team", () => {
	assert.match(indexSource, /registerFlag\("agent-team"/);
	assert.match(indexSource, /resolveStartupRoster\(teams, pi\.getFlag\("agent-team"\)\)/);
	assert.doesNotMatch(indexSource, /activateTeam\(teamNames\[0\]\)/);
});
