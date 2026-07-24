import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseFleetCommand } from "./fleet-command.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertCompleteFleetGuide(output: string): void {
	for (const section of ["QUICK START", "SESSION MODES", "TEAM MODES", "TEAM LIFECYCLE", "HERMES CONDUCTOR", "CODEX REMOTE-CONTROL CONDUCTOR", "CAPABILITY FLAGS", "SETUP"]) {
		assert.match(output, new RegExp(section));
	}
	assert.match(output, /just fleet team frontend --project af/);
	assert.match(output, /Full docs:\s+docs\/pi-extensions\.md/);
}

test("Fleet help is complete without requiring the external just binary", () => {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/fleet.ts", "help"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assertCompleteFleetGuide(result.stdout);
});

test("bare just routes to the complete Fleet guide", (context) => {
	assert.match(readFileSync(resolve(REPO_ROOT, "justfile"), "utf8"), /default:\n\s+@just fleet help/);

	const result = spawnSync("just", [], { cwd: REPO_ROOT, encoding: "utf8" });
	if (result.error && "code" in result.error && result.error.code === "ENOENT") {
		context.skip("just is an external runtime dependency and is not installed");
		return;
	}
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assertCompleteFleetGuide(result.stdout);
});

test("fleet defaults to the guarded core runtime", () => {
	assert.deepEqual(parseFleetCommand([]), {
		recipe: "_fleet-core",
		args: ["false", "false"],
	});
});

test("fleet core capabilities are normalized before Pi arguments", () => {
	assert.deepEqual(parseFleetCommand(["--browser", "--all-extensions", "--model", "openai/gpt"]), {
		recipe: "_fleet-core",
		args: ["true", "true", "--model", "openai/gpt"],
	});
});

test("fleet peer requires an identity and keeps trailing Pi flags", () => {
	assert.deepEqual(parseFleetCommand(["peer", "web-debugger", "--browser", "--project", "af"]), {
		recipe: "_fleet-peer",
		args: ["web-debugger", "true", "false", "--project", "af"],
	});
	assert.throws(() => parseFleetCommand(["peer"]), /peer requires/);
});

test("fleet hub supports solo and optional capabilities", () => {
	assert.deepEqual(parseFleetCommand(["hub", "--solo", "--browser", "--project", "af"]), {
		recipe: "_fleet-hub",
		args: ["true", "true", "false", "--project", "af"],
	});
});

test("fleet team maps hub, peers-only, and dry-run combinations", () => {
	assert.deepEqual(parseFleetCommand(["team", "frontend", "--project", "af"]), {
		recipe: "_fleet-hub-team",
		args: ["frontend", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["team", "frontend", "--no-hub", "--dry-run"]), {
		recipe: "_fleet-team-up-dry",
		args: ["frontend"],
	});
	assert.deepEqual(parseFleetCommand(["team", "web", "--browser", "--dry-run"]), {
		recipe: "_fleet-hub-team-dry",
		args: ["web", "--browser"],
	});
	assert.throws(() => parseFleetCommand(["team", "web", "--no-hub", "--browser"]), /requires the hub/);
});

test("fleet lifecycle commands map to existing control-plane recipes", () => {
	assert.deepEqual(parseFleetCommand(["install"]), { recipe: "_fleet-install", args: [] });
	assert.deepEqual(parseFleetCommand(["snapshot", "docs", "--project", "af"]), {
		recipe: "_fleet-team-snapshot",
		args: ["docs", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["down", "docs"]), { recipe: "_fleet-team-down", args: ["docs"] });
	assert.deepEqual(parseFleetCommand(["resume", "docs"]), { recipe: "_fleet-team-resume", args: ["docs"] });
});

test("fleet conductor maps Hermes and Codex runtime modes", () => {
	assert.deepEqual(parseFleetCommand(["conductor", "hermes", "docs", "--dry-run", "--project", "af"]), {
		recipe: "_fleet-conductor-dry",
		args: ["docs", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["conductor", "codex", "docs", "--project", "af"]), {
		recipe: "_fleet-conductor-codex",
		args: ["docs", "--project", "af"],
	});
});

test("fleet conductor maps Codex service lifecycle", () => {
	assert.deepEqual(parseFleetCommand(["conductor", "codex", "setup", "docs", "--project", "af"]), {
		recipe: "_fleet-conductor-codex-setup",
		args: ["docs", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["conductor", "codex", "pair"]), {
		recipe: "_fleet-conductor-codex-pair",
		args: [],
	});
	assert.deepEqual(parseFleetCommand(["conductor", "codex", "recover"]), {
		recipe: "_fleet-conductor-codex-recover",
		args: [],
	});
});

test("fleet rejects unknown modes and incomplete lifecycle commands", () => {
	assert.throws(() => parseFleetCommand(["wat"]), /Unknown fleet mode/);
	assert.throws(() => parseFleetCommand(["team"]), /team requires/);
	assert.throws(() => parseFleetCommand(["snapshot"]), /snapshot requires/);
	assert.throws(() => parseFleetCommand(["conductor"]), /conductor requires/);
});
