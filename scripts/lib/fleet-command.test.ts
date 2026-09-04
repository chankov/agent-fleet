import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseFleetCommand } from "./fleet-command.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertCompleteFleetGuide(output: string): void {
	for (const section of ["SET UP A NEW REPOSITORY", "QUICK START", "DETERMINISTIC FLOWS", "UNIFIED HUB", "WORK MODE AND ROSTER", "HERDR TOPOLOGY", "TEAM LIFECYCLE", "HERMES CONDUCTOR", "CODEX REMOTE-CONTROL CONDUCTOR", "CAPABILITY FLAGS", "COMPATIBILITY ALIASES", "LIFECYCLE", "UPDATE NOTE"]) {
		assert.match(output, new RegExp(section));
	}
	assert.match(output, /just fleet\s+# Hub\/operator, empty native roster/);
	assert.match(output, /just fleet --agents frontend --peers frontend --project af/);
	assert.match(output, /just flow cleanup 2/);
	assert.match(output, /just flow merge 2/);
	assert.match(output, /\/af-work-mode orchestrator/);
	assert.match(output, /\/af-agents-add code-reviewer/);
	assert.match(output, /backend: "native"/);
	assert.match(output, /herdr_spawn_peer\(\{ name: "code-reviewer" \}\)/);
	assert.match(output, /\/af-handoff code-reviewer/);
	assert.doesNotMatch(output, /Safe interactive Pi without Hub/);
	assert.match(output, /Full docs:\s+docs\/pi-extensions\.md/);
	assert.match(output, /just fleet deps/);
	assert.match(output, /pi update --extensions updates pi extensions only/);
	assert.match(output, /just fleet install was removed/);
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

test("bare fleet selects the Hub in operator work mode with an empty roster", () => {
	assert.deepEqual(parseFleetCommand([]), {
		recipe: "_fleet-hub",
		args: ["false", "false", "false", "false"],
	});
});

test("canonical Hub flags preserve Pi argv and explicit work mode precedence", () => {
	assert.deepEqual(parseFleetCommand(["--browser", "--all-extensions", "--model", "openai/gpt"]), {
		recipe: "_fleet-hub",
		args: ["false", "true", "false", "true", "--model", "openai/gpt"],
	});
	assert.deepEqual(parseFleetCommand(["--agents", "frontend", "--model", "m/x"]), {
		recipe: "_fleet-hub",
		args: ["false", "false", "false", "false", "--agent-team", "frontend", "--model", "m/x"],
	});
	assert.deepEqual(parseFleetCommand(["--work-mode", "operator", "--agents", "frontend", "--project", "af"]), {
		recipe: "_fleet-hub",
		args: ["false", "false", "false", "false", "--work-mode", "operator", "--agent-team", "frontend", "--project", "af"],
	});
});

test("canonical topology flags select Hub-only, peer-preset, and combined Herdr layouts", () => {
	assert.deepEqual(parseFleetCommand(["--herdr", "--project", "af"]), {
		recipe: "_fleet-hub-team",
		args: ["base", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["--peers", "frontend", "--project", "af"]), {
		recipe: "_fleet-hub-team",
		args: ["frontend", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["--agents", "frontend", "--peers", "frontend", "--work-mode", "operator"]), {
		recipe: "_fleet-hub-team",
		args: ["frontend", "--work-mode", "operator", "--agents", "frontend"],
	});
	assert.deepEqual(parseFleetCommand(["--peers", "review", "--dry-run", "--no-coms"]), {
		recipe: "_fleet-hub-team-dry",
		args: ["review", "--no-coms"],
	});
});

test("fleet peer requires an identity and forwards its flag set verbatim", () => {
	// peer-launch.ts owns every flag, including the `--` passthrough to pi, so
	// nothing may be swallowed or reordered on the way to the recipe — unlike
	// core/hub, where --browser/--all-extensions become recipe positionals.
	assert.deepEqual(parseFleetCommand(["peer", "web-debugger", "--browser", "--project", "af"]), {
		recipe: "_fleet-peer-launch",
		args: ["web-debugger", "--browser", "--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["peer", "architect", "--here", "--", "--session", "/tmp/s.json"]), {
		recipe: "_fleet-peer-launch",
		args: ["architect", "--here", "--", "--session", "/tmp/s.json"],
	});
	assert.throws(() => parseFleetCommand(["peer"]), /peer requires a peer name/);
	assert.throws(() => parseFleetCommand(["peer", "--runner", "claude-code"]), /peer requires a peer name/);
});

test("legacy hub and --solo map deterministically with migration warnings", () => {
	assert.deepEqual(parseFleetCommand(["hub", "--solo", "--browser", "--project", "af"]), {
		recipe: "_fleet-hub",
		args: ["true", "true", "false", "false", "--agent-team", "default", "--project", "af"],
		warnings: [
			"`just fleet hub` is a compatibility alias; use `just fleet` with canonical flags.",
			"`--solo` is deprecated; use `--no-coms`.",
		],
	});
	assert.deepEqual(parseFleetCommand(["--solo"]), {
		recipe: "_fleet-hub",
		args: ["true", "false", "false", "false"],
		warnings: ["`--solo` is deprecated; use `--no-coms`."],
	});
});

test("Fleet entrypoint prints compatibility guidance before launching the mapped recipe", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-warning-"));
	try {
		const fakeJust = join(dir, "just");
		writeFileSync(fakeJust, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
		chmodSync(fakeJust, 0o755);
		// Keep this compatibility-routing test independent from the checkout's
		// nested npm install state. Dependency refusal has its own fixture below.
		const result = spawnSync(process.execPath, ["--experimental-strip-types", join(REPO_ROOT, "scripts", "fleet.ts"), "hub", "--solo"], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, AGENT_FLEET_MONITOR: "0" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /compatibility alias/);
		assert.match(result.stderr, /--solo.*deprecated/);
		assert.equal(result.stdout.trim(), "_fleet-hub true false false false --agent-team default");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Fleet launcher blocks before Just/Pi when a runtime dependency root is incomplete", () => {
	const ws = mkdtempSync(join(tmpdir(), "fleet-dependency-preflight-"));
	const fakeBin = join(ws, "bin");
	const marker = join(ws, "just-was-called");
	try {
		mkdirSync(join(ws, "scripts"), { recursive: true });
		writeFileSync(join(ws, "scripts", "package.json"), JSON.stringify({
			private: true,
			dependencies: { "definitely-missing-agent-fleet-fixture": "1.0.0" },
		}));
		mkdirSync(fakeBin);
		const fakeJust = join(fakeBin, "just");
		writeFileSync(fakeJust, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		chmodSync(fakeJust, 0o755);

		const result = spawnSync(process.execPath, ["--experimental-strip-types", join(REPO_ROOT, "scripts", "fleet.ts")], {
			cwd: ws,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
				AGENT_FLEET_MONITOR: "0",
				npm_config_cache: join(ws, ".npm-cache"),
			},
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /runtime dependencies are incomplete/);
		assert.match(result.stderr, /scripts\/node_modules is missing/);
		assert.match(result.stderr, /just fleet deps/);
		assert.match(result.stderr, /setup --allow-exec/);
		assert.doesNotMatch(result.stderr, /Unknown option: --project/);
		assert.equal(existsSync(marker), false, "Just/Pi must not start after failed preflight");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("legacy team maps matching native roster and peer preset, while peers-only stays compatible", () => {
	assert.deepEqual(parseFleetCommand(["team", "frontend", "--project", "af"]), {
		recipe: "_fleet-hub-team",
		args: ["frontend", "--legacy-agents", "frontend", "--project", "af"],
		warnings: ["`just fleet team frontend` is a compatibility alias; use `just fleet --agents <roster> --peers frontend`."],
	});
	assert.deepEqual(parseFleetCommand(["team", "base", "--project", "af"]), {
		recipe: "_fleet-hub-team",
		args: ["base", "--project", "af"],
		warnings: ["`just fleet team base` is a compatibility alias; use `just fleet --herdr`."],
	});
	assert.deepEqual(parseFleetCommand(["team", "frontend", "--no-hub", "--dry-run"]), {
		recipe: "_fleet-team-up-dry",
		args: ["frontend"],
		warnings: ["`just fleet team frontend --no-hub` is a compatibility alias; prefer `just fleet peer` or a canonical Hub topology."],
	});
	assert.deepEqual(parseFleetCommand(["team", "web", "--browser", "--dry-run"]), {
		recipe: "_fleet-hub-team-dry",
		args: ["web", "--legacy-agents", "web", "--browser"],
		warnings: ["`just fleet team web` is a compatibility alias; use `just fleet --agents <roster> --peers web`."],
	});
	assert.throws(() => parseFleetCommand(["team", "web", "--no-hub", "--browser"]), /requires the hub/);
});

test("fleet lifecycle commands map to deterministic CLI and dependency recipes", () => {
	const justfile = readFileSync(resolve(REPO_ROOT, "justfile"), "utf8");
	assert.match(justfile, /_fleet-lifecycle command \*args:\n\s+npx @chankov\/agent-fleet@latest \{\{command\}\}/);
	assert.match(justfile, /_fleet-deps:\n\s+npm install --prefix \.pi\/extensions\n\s+npm install --prefix \.pi\/harnesses\n\s+npm install --prefix scripts/);
	assert.deepEqual(parseFleetCommand(["setup", "--preset", "default", "--yes"]), { recipe: "_fleet-lifecycle", args: ["setup", "--preset", "default", "--yes"] });
	assert.deepEqual(parseFleetCommand(["deps"]), { recipe: "_fleet-deps", args: [] });
	assert.throws(() => parseFleetCommand(["install"]), /use `just fleet setup`.*`just fleet deps`/);
	assert.deepEqual(parseFleetCommand(["setup", "--preset", "default", "--yes"]), { recipe: "_fleet-lifecycle", args: ["setup", "--preset", "default", "--yes"] });
	assert.deepEqual(parseFleetCommand(["doctor", "--fix"]), { recipe: "_fleet-lifecycle", args: ["doctor", "--fix"] });
	assert.deepEqual(parseFleetCommand(["uninstall", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--yes"] });
	assert.equal(parseFleetCommand(["uninstall", "--yes"]).args.includes("--all"), false, "dispatcher never injects implicit --all");
	assert.deepEqual(parseFleetCommand(["uninstall", "--all", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--all", "--yes"] });
	assert.deepEqual(parseFleetCommand(["uninstall", "--items", "pi-harness:coms", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--items", "pi-harness:coms", "--yes"] });
	assert.deepEqual(parseFleetCommand(["--voice", "--model", "openai/gpt"]), { recipe: "_fleet-hub", args: ["false", "false", "true", "false", "--model", "openai/gpt"] });
	assert.deepEqual(parseFleetCommand(["hub", "--voice"]), { recipe: "_fleet-hub", args: ["false", "false", "true", "false", "--agent-team", "default"], warnings: ["`just fleet hub` is a compatibility alias; use `just fleet` with canonical flags."] });
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

test("fleet rejects unknown modes, invalid canonical combinations, and duplicate Fleet flags", () => {
	assert.throws(() => parseFleetCommand(["wat"]), /Unknown fleet mode/);
	assert.throws(() => parseFleetCommand(["team"]), /team requires/);
	assert.throws(() => parseFleetCommand(["snapshot"]), /snapshot requires/);
	assert.throws(() => parseFleetCommand(["conductor"]), /conductor requires/);
	assert.throws(() => parseFleetCommand(["--work-mode", "invalid"]), /operator or orchestrator/);
	assert.throws(() => parseFleetCommand(["--work-mode", "orchestrator"]), /requires --agents/);
	for (const retiredPostureArgs of [["--posture", "operator"], ["--posture=operator"], ["--", "--posture", "operator"]]) {
		assert.throws(() => parseFleetCommand(retiredPostureArgs), /--posture was removed; use --work-mode/);
	}
	assert.throws(() => parseFleetCommand(["--agents"]), /--agents requires/);
	assert.throws(() => parseFleetCommand(["--peers", "a", "--peers", "b"]), /--peers may only/);
	assert.throws(() => parseFleetCommand(["--no-coms", "--solo"]), /only be provided once/);
	assert.throws(() => parseFleetCommand(["--dry-run"]), /requires --herdr or --peers/);
});
