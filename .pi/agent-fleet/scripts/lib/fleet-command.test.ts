import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseFleetCommand } from "./fleet-command.ts";

test('explicit worktree parsing is independent of topology and strips only startup selection',()=>{
 const selected=parseFleetCommand(['--worktree','../repo.worktree','--no-coms','--dry-run']);
 assert.equal(selected.recipe,'_fleet-hub');assert.equal(selected.preview,true);assert.deepEqual(selected.selection,{worktree:'../repo.worktree',repository:undefined});assert.ok(!selected.args.includes('--worktree'));assert.ok(!selected.args.includes('--dry-run'));
 const topology=parseFleetCommand(['--herdr','--worktree','../repo.worktree','--dry-run']);assert.equal(topology.recipe,'_fleet-herdr');assert.equal(topology.dryRun,true);assert.equal(topology.preview,undefined);assert.ok(topology.selection);
 assert.equal(parseFleetCommand(['peer','builder','--worktree','../repo.worktree','--dry-run']).recipe,'_fleet-peer-launch');
 assert.throws(()=>parseFleetCommand(['--worktree','a','--worktree','b']));assert.throws(()=>parseFleetCommand(['--worktree']));assert.throws(()=>parseFleetCommand(['setup','--worktree','../repo']));
 assert.ok(parseFleetCommand(['--','--worktree','prompt text']).args.includes('--worktree'));
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function assertCompleteFleetGuide(output: string): void {
	for (const section of ["SET UP A NEW REPOSITORY", "QUICK START", "DETERMINISTIC FLOWS", "UNIFIED HUB", "HERDR", "ONE STANDALONE PEER", "HERMES CONDUCTOR", "CAPABILITY FLAGS", "COMPATIBILITY ALIASES", "LIFECYCLE", "UPDATE NOTE"]) {
		assert.match(output, new RegExp(section));
	}
	assert.match(output, /just fleet\s+# Hub\/operator with the editor, researcher and reviewer roles/);
	assert.match(output, /just fleet --herdr --project af/);
	assert.match(output, /just fleet peer <name> \[--runner pi\|claude-code\]/);
	assert.match(output, /\[--model <m>\] \[--read-only\] \[--env-file <path>\]/);
	assert.match(output, /just fleet conductor hermes \[name\]/);
	assert.match(output, /just flow cleanup 2/);
	assert.match(output, /just flow merge 2/);
	assert.doesNotMatch(output, /\/af-work-mode|orchestrator/);
	// Peer groups and native teams are gone (PLAN-11-01, D7/D8/D14/D16).
	assert.doesNotMatch(output, /\/af-agents-|teams\.yaml|peers\.yaml|--agents <|--peers <|TEAM LIFECYCLE|ROSTER|--extensions a,b|code-reviewer/);
	assert.match(output, /backend: "native"/);
	assert.match(output, /herdr_spawn_peer\(\{ name: "claude-reviewer", runner: "claude-code", read_only: true \}\)/);
	assert.match(output, /\/af-handoff claude-reviewer/);
	assert.doesNotMatch(output, /Safe interactive Pi without Hub/);
	assert.match(output, /Full docs:\s+docs\/pi-extensions\.md/);
	assert.match(output, /just fleet deps/);
	assert.match(output, /pi update --extensions updates pi extensions only/);
	assert.match(output, /just fleet install was removed/);
}

test("Fleet help is complete without requiring the external just binary", () => {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", ".pi/agent-fleet/scripts/fleet.ts", "help"], {
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

test("bare fleet selects the Hub in operator work mode", () => {
	assert.deepEqual(parseFleetCommand([]), {
		recipe: "_fleet-hub",
		args: ["false", "false", "false", "false"],
	});
});

test("canonical Hub flags preserve Pi argv; the deprecated --work-mode is dropped with a warning", () => {
	assert.deepEqual(parseFleetCommand(["--browser", "--all-extensions", "--model", "openai/gpt"]), {
		recipe: "_fleet-hub",
		args: ["false", "true", "false", "true", "--model", "openai/gpt"],
	});
	const legacy = parseFleetCommand(["--work-mode", "orchestrator", "--project", "af"]);
	assert.equal(legacy.recipe, "_fleet-hub");
	assert.deepEqual(legacy.args, ["false", "false", "false", "false", "--project", "af"]);
	assert.ok(legacy.warnings?.some(warning => /--work-mode orchestrator. is deprecated and ignored/.test(warning)), JSON.stringify(legacy.warnings));
});

test("--herdr selects the one-pane Hub launcher and forwards only the Hub's own flags", () => {
	assert.deepEqual(parseFleetCommand(["--herdr", "--project", "af"]), {
		recipe: "_fleet-herdr",
		args: ["--project", "af"],
	});
	assert.deepEqual(parseFleetCommand(["--herdr", "--no-coms", "--browser", "--voice", "--all-extensions", "--project", "af", "--dry-run"]), {
		recipe: "_fleet-herdr",
		args: ["--no-coms", "--browser", "--voice", "--all-extensions", "--project", "af", "--dry-run"],
		dryRun: true,
	});
	const solo = parseFleetCommand(["--herdr", "--solo"]);
	assert.deepEqual(solo.args, ["--no-coms"]);
	assert.throws(() => parseFleetCommand(["--herdr", "--model", "m/x"]), /forwards no Pi arguments \(got --model m\/x\)/);
	assert.throws(() => parseFleetCommand(["--herdr", "--", "prompt"]), /forwards no Pi arguments/);
});

test("removed peer-group flags are refused with the reason, never passed to pi", () => {
	assert.throws(() => parseFleetCommand(["--agents", "frontend"]), /--agents was removed: the Hub always has the editor, researcher and reviewer roles/);
	assert.throws(() => parseFleetCommand(["--peers", "review", "--project", "af"]), /--peers was removed with peer groups: start each peer with `just fleet peer <name>`/);
	assert.throws(() => parseFleetCommand(["hub", "--agents", "default"]), /--agents was removed/);
	// After `--` they are Pi arguments like any other.
	assert.deepEqual(parseFleetCommand(["--", "--agents"]).args.slice(-2), ["--", "--agents"]);
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
		args: ["true", "true", "false", "false", "--project", "af"],
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
		const result = spawnSync(process.execPath, ["--experimental-strip-types", join(REPO_ROOT, ".pi", "agent-fleet", "scripts", "fleet.ts"), "hub", "--solo"], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, AGENT_FLEET_MONITOR: "0" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /compatibility alias/);
		assert.match(result.stderr, /--solo.*deprecated/);
		assert.equal(result.stdout.trim(), "_fleet-hub true false false false");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Fleet launcher blocks before Just/Pi when a runtime dependency root is incomplete", () => {
	const ws = mkdtempSync(join(tmpdir(), "fleet-dependency-preflight-"));
	const fakeBin = join(ws, "bin");
	const marker = join(ws, "just-was-called");
	try {
		mkdirSync(join(ws, ".pi", "agent-fleet", "scripts"), { recursive: true });
		writeFileSync(join(ws, ".pi", "agent-fleet", "scripts", "package.json"), JSON.stringify({
			private: true,
			dependencies: { "definitely-missing-agent-fleet-fixture": "1.0.0" },
		}));
		mkdirSync(fakeBin);
		const fakeJust = join(fakeBin, "just");
		writeFileSync(fakeJust, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		chmodSync(fakeJust, 0o755);

		const result = spawnSync(process.execPath, ["--experimental-strip-types", join(REPO_ROOT, ".pi", "agent-fleet", "scripts", "fleet.ts")], {
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

test("only `fleet team base` survives as an alias of --herdr; other peer-group modes are refused", () => {
	assert.deepEqual(parseFleetCommand(["team", "base", "--project", "af"]), {
		recipe: "_fleet-herdr",
		args: ["--project", "af"],
		warnings: ["`just fleet team base` is a compatibility alias; use `just fleet --herdr`."],
	});
	assert.deepEqual(parseFleetCommand(["team", "base", "--dry-run"]), {
		recipe: "_fleet-herdr",
		args: ["--dry-run"],
		dryRun: true,
		warnings: ["`just fleet team base` is a compatibility alias; use `just fleet --herdr`."],
	});
	assert.throws(() => parseFleetCommand(["team", "frontend", "--project", "af"]), /`just fleet team frontend` was removed with peer groups: use `just fleet --herdr` for the Hub and `just fleet peer <name>` for each peer/);
	assert.throws(() => parseFleetCommand(["team", "web", "--no-hub"]), /was removed with peer groups/);
	for (const mode of ["snapshot", "down", "resume"]) {
		assert.throws(() => parseFleetCommand([mode, "docs"]), new RegExp(`\`just fleet ${mode}\` was removed with peer groups`));
	}
});

test("fleet lifecycle commands map to deterministic CLI and dependency recipes", () => {
	const justfile = readFileSync(resolve(REPO_ROOT, "justfile"), "utf8");
	assert.match(justfile, /_fleet-lifecycle command \*args:\n\s+npx @chankov\/agent-fleet@latest \{\{command\}\}/);
	assert.match(justfile, /_fleet-deps:\n\s+npm install --prefix \.pi\/extensions\n\s+npm install --prefix \.pi\/harnesses\n\s+npm install --prefix \.pi\/agent-fleet\/scripts/);
	assert.deepEqual(parseFleetCommand(["setup", "--preset", "default", "--yes"]), { recipe: "_fleet-lifecycle", args: ["setup", "--preset", "default", "--yes"] });
	assert.deepEqual(parseFleetCommand(["deps"]), { recipe: "_fleet-deps", args: [] });
	assert.throws(() => parseFleetCommand(["install"]), /use `just fleet setup`.*`just fleet deps`/);
	assert.deepEqual(parseFleetCommand(["setup", "--preset", "default", "--yes"]), { recipe: "_fleet-lifecycle", args: ["setup", "--preset", "default", "--yes"] });
	assert.deepEqual(parseFleetCommand(["doctor", "--fix"]), { recipe: "_fleet-lifecycle", args: ["doctor", "--fix"] });
	assert.deepEqual(parseFleetCommand(["config"]), { recipe: "_fleet-lifecycle", args: ["inspect"] }, "just fleet config is the terminal twin of /af-config");
	assert.deepEqual(parseFleetCommand(["inspect", "--agent", "pi"]), { recipe: "_fleet-lifecycle", args: ["inspect", "--agent", "pi"] });
	assert.deepEqual(parseFleetCommand(["uninstall", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--yes"] });
	assert.equal(parseFleetCommand(["uninstall", "--yes"]).args.includes("--all"), false, "dispatcher never injects implicit --all");
	assert.deepEqual(parseFleetCommand(["uninstall", "--all", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--all", "--yes"] });
	assert.deepEqual(parseFleetCommand(["uninstall", "--items", "pi-harness:coms", "--yes"]), { recipe: "_fleet-lifecycle", args: ["uninstall", "--items", "pi-harness:coms", "--yes"] });
	assert.deepEqual(parseFleetCommand(["--voice", "--model", "openai/gpt"]), { recipe: "_fleet-hub", args: ["false", "false", "true", "false", "--model", "openai/gpt"] });
	assert.deepEqual(parseFleetCommand(["hub", "--voice"]), { recipe: "_fleet-hub", args: ["false", "false", "true", "false"], warnings: ["`just fleet hub` is a compatibility alias; use `just fleet` with canonical flags."] });
});

test("fleet conductor maps Hermes to the one-pane launcher and refuses Codex", () => {
	assert.deepEqual(parseFleetCommand(["conductor", "hermes", "docs", "--dry-run", "--project", "af"]), {
		recipe: "_fleet-conductor",
		args: ["docs", "--dry-run", "--project", "af"],
		dryRun: true,
	});
	assert.deepEqual(parseFleetCommand(["conductor", "hermes", "--project", "af"]), {
		recipe: "_fleet-conductor",
		args: ["full", "--project", "af"],
	});
	assert.throws(() => parseFleetCommand(["conductor", "codex", "docs"]), /Unknown conductor backend/);
});

test("fleet rejects unknown modes, invalid canonical combinations, and duplicate Fleet flags", () => {
	assert.throws(() => parseFleetCommand(["wat"]), /Unknown fleet mode/);
	assert.throws(() => parseFleetCommand(["team"]), /team requires/);
	assert.throws(() => parseFleetCommand(["conductor"]), /conductor requires/);
	assert.throws(() => parseFleetCommand(["--work-mode"]), /--work-mode requires a value/);
	assert.throws(() => parseFleetCommand(["--work-mode", "operator", "--work-mode", "operator"]), /--work-mode may only be provided once/);
	for (const retiredPostureArgs of [["--posture", "operator"], ["--posture=operator"], ["--", "--posture", "operator"]]) {
		assert.throws(() => parseFleetCommand(retiredPostureArgs), /--posture was removed; the Hub has one operator work mode/);
	}
	assert.throws(() => parseFleetCommand(["--herdr", "--herdr"]), /--herdr may only/);
	assert.throws(() => parseFleetCommand(["--no-coms", "--solo"]), /only be provided once/);
	assert.throws(() => parseFleetCommand(["--dry-run"]), /--dry-run requires --herdr/);
});
