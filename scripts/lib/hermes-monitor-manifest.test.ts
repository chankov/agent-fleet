import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dashboard = join(repositoryRoot, "hermes", "plugins", "agent-fleet-monitor", "dashboard");
const manifestPath = join(dashboard, "manifest.json");
const bundlePath = join(dashboard, "dist", "index.js");
const apiPath = join(dashboard, "plugin_api.py");

test("hidden dashboard manifest, bundle, and API use the same verified plugin ID", () => {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const bundle = readFileSync(bundlePath, "utf8");
	const api = readFileSync(apiPath, "utf8");

	assert.deepEqual(manifest, {
		name: "agent-fleet-monitor",
		label: "Agent Fleet Monitor",
		version: "0.1.0",
		tab: { path: "/agent-fleet-monitor", hidden: true },
		entry: "dist/index.js",
		api: "plugin_api.py",
	});
	assert.match(bundle, /register\("agent-fleet-monitor"/);
	assert.match(api, /router = APIRouter\(\)/);
	assert.match(api, /@router\.get\("\/capabilities"\)/);
	assert.match(api, /from adapter import MonitorAdapter, MonitorUnavailable/);
	assert.doesNotMatch(api, /^(?:from|import) .*\bherdr\b/m);
	assert.doesNotMatch(api, /lifecycle/i);
});

test("dashboard bundle and plugin API are independently loadable syntax", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "agent-fleet-monitor-manifest-"));
	const tempApiPath = join(tempDir, "plugin_api.py");
	try {
		writeFileSync(tempApiPath, readFileSync(apiPath));
		execFileSync(process.execPath, ["--check", bundlePath], { stdio: "pipe" });
		execFileSync("python3", ["-B", "-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", tempApiPath], {
			stdio: "pipe",
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		assert.equal(existsSync(join(tempDir, "__pycache__")), false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
