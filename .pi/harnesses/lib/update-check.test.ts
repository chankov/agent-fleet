import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	formatUpdateBanner,
	isNewerVersion,
	isUpdateCheckDisabled,
	runFleetUpdateCheck,
	PACKAGE_NAME,
	RELEASES_URL,
} from "./update-check.ts";

function workspace(version?: string) {
	const dir = mkdtempSync(join(tmpdir(), "af-update-check-"));
	if (version) {
		mkdirSync(join(dir, ".ai"), { recursive: true });
		writeFileSync(join(dir, ".ai", "agent-fleet-setup.md"), `version: ${version}\n`, "utf8");
	}
	return dir;
}

function ctx() {
	const calls: { message: string; level?: string }[] = [];
	return {
		calls,
		ctx: {
			cwd: "",
			hasUI: true,
			ui: {
				notify: (message: string, level?: string) => {
					calls.push({ message, level });
				},
			},
		},
	};
}

test("isUpdateCheckDisabled honors the three opt-outs", () => {
	assert.equal(isUpdateCheckDisabled({}), false);
	assert.equal(isUpdateCheckDisabled({ AGENT_SKILLS_NO_UPDATE_CHECK: "1" }), true);
	assert.equal(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
	assert.equal(isUpdateCheckDisabled({ CI: "true" }), true);
	assert.equal(isUpdateCheckDisabled({ CI: "1" }), false);
});

test("isNewerVersion compares release and prerelease versions", () => {
	assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
	assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
	assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
	assert.equal(isNewerVersion("1.0.0", "1.0.0-beta.1"), true);
	assert.equal(isNewerVersion("1.0.0-beta.1", "1.0.0"), false);
	assert.equal(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1"), true);
});

test("formatUpdateBanner names setup, dry-run, and releases", () => {
	const banner = formatUpdateBanner("0.1.0", "0.2.0");
	assert.match(banner, /0\.1\.0 → 0\.2\.0/);
	assert.match(banner, new RegExp(`npx ${PACKAGE_NAME.replace("/", "\\/")}@latest setup`));
	assert.match(banner, /setup --dry-run/);
	assert.match(banner, new RegExp(RELEASES_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runFleetUpdateCheck skips when there is no UI or notify", async () => {
	const cwd = workspace("0.1.0");
	assert.equal(await runFleetUpdateCheck({ cwd, hasUI: false, ui: { notify() {} } }), null);
	assert.equal(await runFleetUpdateCheck({ cwd, hasUI: true, ui: {} }), null);
});

test("runFleetUpdateCheck skips hub children", async () => {
	const cwd = workspace("0.1.0");
	const { ctx: c } = ctx();
	c.cwd = cwd;
	assert.equal(await runFleetUpdateCheck(c, { env: { AGENT_HUB_AGENT_ID: "builder" } }), null);
});

test("runFleetUpdateCheck skips when the install record is missing", async () => {
	const cwd = workspace();
	const { ctx: c, calls } = ctx();
	c.cwd = cwd;
	assert.equal(await runFleetUpdateCheck(c, { fetchLatest: async () => "9.9.9" }), null);
	assert.equal(calls.length, 0);
});

test("runFleetUpdateCheck notifies from a fresh cache without fetching", async () => {
	const cwd = workspace("0.1.0");
	const cacheFile = join(mkdtempSync(join(tmpdir(), "af-update-cache-")), "latest-version.json");
	writeFileSync(cacheFile, JSON.stringify({ latest: "0.2.0", checkedAt: Date.now() }), "utf8");
	const { ctx: c, calls } = ctx();
	c.cwd = cwd;
	let fetched = 0;
	const banner = await runFleetUpdateCheck(c, {
		cacheFile,
		fetchLatest: async () => {
			fetched++;
			return "9.9.9";
		},
	});
	assert.equal(fetched, 0);
	assert.match(banner ?? "", /0\.1\.0 → 0\.2\.0/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].level, "info");
});

test("runFleetUpdateCheck fetches and caches when the cache is stale", async () => {
	const cwd = workspace("1.0.0");
	const cacheDir = mkdtempSync(join(tmpdir(), "af-update-cache-"));
	const cacheFile = join(cacheDir, "latest-version.json");
	writeFileSync(cacheFile, JSON.stringify({ latest: "1.0.0", checkedAt: 1 }), "utf8");
	const { ctx: c, calls } = ctx();
	c.cwd = cwd;
	const banner = await runFleetUpdateCheck(c, {
		cacheFile,
		fetchLatest: async () => "1.1.0",
	});
	assert.match(banner ?? "", /1\.0\.0 → 1\.1\.0/);
	assert.equal(calls.length, 1);
	const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
	assert.equal(cached.latest, "1.1.0");
	assert.ok(cached.checkedAt > 1);
	assert.equal(existsSync(cacheFile), true);
});

test("runFleetUpdateCheck stays silent when published equals recorded", async () => {
	const cwd = workspace("2.0.0");
	const cacheFile = join(mkdtempSync(join(tmpdir(), "af-update-cache-")), "latest-version.json");
	const { ctx: c, calls } = ctx();
	c.cwd = cwd;
	assert.equal(await runFleetUpdateCheck(c, { cacheFile, fetchLatest: async () => "2.0.0" }), null);
	assert.equal(calls.length, 0);
});

test("runFleetUpdateCheck swallows fetch failures", async () => {
	const cwd = workspace("0.1.0");
	const cacheFile = join(mkdtempSync(join(tmpdir(), "af-update-cache-")), "latest-version.json");
	const { ctx: c, calls } = ctx();
	c.cwd = cwd;
	assert.equal(await runFleetUpdateCheck(c, {
		cacheFile,
		fetchLatest: async () => {
			throw new Error("boom");
		},
	}), null);
	assert.equal(calls.length, 0);
});
