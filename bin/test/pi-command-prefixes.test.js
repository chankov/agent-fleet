import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../lib/bootstrap.js";
import { loadManifest } from "../lib/manifest.js";
import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { runVerify } from "../lib/verify.js";

const commandSources = [
	".pi/extensions/btw/index.ts",
	".pi/extensions/pi-voice-stt/index.ts",
	".pi/harnesses/agent-hub/index.ts",
	".pi/harnesses/coms/index.ts",
	".pi/harnesses/damage-control-continue/index.ts",
];

test("Agent Fleet pi extensions and harnesses namespace public commands with af-", () => {
	for (const path of commandSources) {
		const source = readFileSync(resolve(path), "utf8");
		const commands = [...source.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]);
		assert.ok(commands.length > 0, `${path} should register at least one command`);
		for (const command of commands) {
			assert.match(command, /^af-/, `${path} registers unprefixed /${command}`);
		}
	}
});

test("Agent Fleet's Chrome DevTools wrapper namespaces its generated status command", () => {
	const source = readFileSync(resolve(".pi/extensions/chrome-devtools-mcp/index.ts"), "utf8");
	assert.match(source, /statusCommandName:\s*"af-chrome-devtools-status"/);
});

test("Agent Fleet pi prompt-template filenames namespace public commands with af-", () => {
	const prompts = readdirSync(resolve(".pi/prompts")).filter((name) => name.endsWith(".md"));
	assert.ok(prompts.length > 0, ".pi/prompts should contain prompt templates");
	for (const prompt of prompts) {
		assert.match(prompt, /^af-/, `.pi/prompts/${prompt} exposes an unprefixed command`);
	}
});

test("pi bootstrap removes pre-prefix installer prompts during upgrade", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-prefix-"));
	const promptsDir = join(workspace, ".pi", "prompts");
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(promptsDir, "setup-agent-fleet.md"), "legacy setup");
	writeFileSync(join(promptsDir, "doctor-agent-fleet.md"), "legacy doctor");

	const result = bootstrap({ agent: "pi", sourceRoot: resolve("."), workspace, method: "copy" });

	assert.deepEqual(
		result.removed.map((path) => path.slice(workspace.length + 1)).sort(),
		[".pi/prompts/doctor-agent-fleet.md", ".pi/prompts/setup-agent-fleet.md"],
	);
	assert.deepEqual(
		readdirSync(promptsDir).sort(),
		["af-doctor-agent-fleet.md", "af-setup-agent-fleet.md"],
	);
});

test("pi init handoff names the prefixed setup command", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-handoff-"));
	const result = spawnSync(
		process.execPath,
		["bin/cli.js", "init", "--agent", "pi", "--workspace", workspace, "--dry-run"],
		{ cwd: resolve("."), encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Open pi .*\/af-setup-agent-fleet/s);
	assert.doesNotMatch(result.stdout, /run:\s*\n\s*\/setup-agent-fleet/);
});

// The `af-` migration used to be prose in guided-workspace-setup/SKILL.md. It
// is now a declared `legacyTargets` binding that apply() retires under the same
// ownership rule as any other removal — see plans/deterministic-installer.md
// phase 7.
test("every prefixed command declares the unprefixed path it replaced", () => {
	const manifest = loadManifest(resolve("."));
	const commands = manifest.items.filter((i) => i.kind === "command");
	assert.ok(commands.length > 0);

	for (const command of commands) {
		for (const [agent, binding] of Object.entries(command.agents)) {
			const prefixed = binding.target.split("/").pop().startsWith("af-");
			assert.equal(
				Boolean(binding.legacyTargets?.length), prefixed,
				`${command.id} (${agent}): legacyTargets should be declared exactly for af- targets`,
			);
			if (!prefixed) continue;
			assert.deepEqual(binding.legacyTargets, [binding.target.replace("/af-", "/")]);
		}
	}
});

test("installing retires an unprefixed prompt we own, and keeps one the user wrote", () => {
	const sourceRoot = resolve(".");
	const manifest = loadManifest(sourceRoot);
	const shipped = readFileSync(join(sourceRoot, ".pi/prompts/af-spec.md"), "utf8");

	const run = (legacyContents) => {
		const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-migrate-"));
		mkdirSync(join(workspace, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(workspace, ".pi/prompts/spec.md"), legacyContents);

		const plan = buildPlan({
			workspace, sourceRoot, packageVersion: manifest.packageVersion, manifest,
			verb: "install", agent: "pi", items: ["command:spec"], platform: "linux",
		});
		const applied = applyPlan({ plan, manifest });
		return { workspace, applied };
	};

	// Byte-identical to what we shipped: ours, so it goes.
	const ours = run(shipped);
	assert.equal(existsSync(join(ours.workspace, ".pi/prompts/spec.md")), false);
	assert.equal(existsSync(join(ours.workspace, ".pi/prompts/af-spec.md")), true);
	assert.match(
		ours.applied.results.find((r) => r.id === "command:spec").detail,
		/retired \.pi\/prompts\/spec\.md/,
	);

	// A same-named prompt the user wrote: never ours to delete.
	const theirs = run("# my own /spec prompt\n");
	assert.equal(
		readFileSync(join(theirs.workspace, ".pi/prompts/spec.md"), "utf8"),
		"# my own /spec prompt\n",
	);
});

test("verify reports a lingering unprefixed prompt instead of staying silent", async () => {
	const sourceRoot = resolve(".");
	const manifest = loadManifest(sourceRoot);
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-stale-"));
	mkdirSync(join(workspace, ".pi", "prompts"), { recursive: true });
	writeFileSync(join(workspace, ".pi/prompts/spec.md"), "stale\n");

	const report = await runVerify({
		workspace, sourceRoot, packageVersion: manifest.packageVersion, manifest,
		agent: "pi", platform: "linux", includeDoctor: false,
	});

	const finding = report.findings.find((f) => f.type === "legacy-target");
	assert.ok(finding, "no legacy-target finding");
	assert.equal(finding.path, ".pi/prompts/spec.md");
	assert.equal(finding.severity, "advisory", "a stale prompt is not a broken workspace");
});
