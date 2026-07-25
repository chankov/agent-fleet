// Dedicated release-surface gate for the Hermes watchdog: every runtime file a
// consumer needs must ship, and nothing local, secret, or test-only may ride along.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
const paths = packed[0].files.map(({ path }) => path);
const packedSet = new Set(paths);

/** Paths a consumer sees, excluding the historical `.versions/` snapshots. */
const current = paths.filter(path => !path.startsWith(".versions/"));

const RUNTIME_PYTHON = [
  "watchdog.py",
  "watchdog_actions.py",
  "watchdog_contract.py",
  "watchdog_delivery.py",
  "watchdog_engine.py",
  "watchdog_judgment.py",
  "watchdog_recovery.py",
  "watchdog_state.py",
  "watchdog_transport.py",
];

test("every runtime watchdog module ships with its skill and manifest", () => {
  for (const module of RUNTIME_PYTHON) {
    assert.ok(packedSet.has(`hermes/skills/hub-watchdog/scripts/${module}`), `missing runtime module: ${module}`);
  }
  assert.ok(packedSet.has("hermes/skills/hub-watchdog/SKILL.md"));
  assert.ok(packedSet.has("hermes/skills/hub-watchdog/manifest.json"));
});

test("the packaged skill imports nothing that was left out of the tarball", () => {
  const shipped = new Set(RUNTIME_PYTHON.map(name => name.replace(/\.py$/, "")));
  for (const module of RUNTIME_PYTHON) {
    const source = readFileSync(join(root, "hermes/skills/hub-watchdog/scripts", module), "utf8");
    const imports = [...source.matchAll(/^(?:from|import)\s+(watchdog[A-Za-z_]*)/gm)].map(match => match[1]);
    for (const imported of imports) {
      assert.ok(shipped.has(imported), `${module} imports ${imported}, which is not packaged`);
    }
  }
});

test("documented plugin and desktop monitor source ships", () => {
  assert.ok(packedSet.has("hermes/plugins/agent-fleet-monitor/dashboard/adapter.py"));
  assert.ok(packedSet.has("hermes/plugins/agent-fleet-monitor/dashboard/plugin_api.py"));
  assert.ok(packedSet.has("hermes/plugins/agent-fleet-monitor/dashboard/manifest.json"));
  assert.ok(packedSet.has("hermes/desktop-plugins/agent-fleet-monitor/plugin.js"));
  assert.ok(packedSet.has("hermes/desktop-plugins/agent-fleet-monitor/state.js"));
  assert.ok(packedSet.has("hermes/README.md"));
});

test("the lifecycle CLI, its guided commands, and the runbook ship together", () => {
  for (const required of [
    "bin/cli.js",
    "bin/lib/set-hermes-watchdog.js",
    "bin/lib/hermes-profile-artifact.js",
    ".claude/commands/set-hermes-watchdog.md",
    ".opencode/commands/af-set-hermes-watchdog.md",
    ".pi/prompts/af-set-hermes-watchdog.md",
    "docs/hermes-watchdog-supervisor.md",
    "docs/coms-hermes-bridge.md",
  ]) {
    assert.ok(packedSet.has(required), `missing lifecycle surface: ${required}`);
  }
});

test("no Python test module, bytecode, or cache directory is published", () => {
  const forbidden = current.filter(path =>
    path.startsWith("hermes/watchdog-tests/")
    || /(^|\/)test_[^/]*\.py$/.test(path)
    || /\.test\.py$/.test(path)
    || path.endsWith(".pyc")
    || path.includes("__pycache__")
    || path.includes(".pytest_cache"),
  );

  assert.deepEqual(forbidden, []);
});

test("the package.json allowlist excludes both Python test naming conventions", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.ok(pkg.files.includes("!**/*.test.py"), "dashboard-style *.test.py exclusion");
  assert.ok(pkg.files.includes("!**/test_*.py"), "unittest-style test_*.py exclusion");
  assert.ok(pkg.files.includes("!hermes/watchdog-tests/"));
  assert.ok(pkg.files.includes("!hermes/**/__pycache__/"));
  assert.ok(pkg.files.includes("!hermes/**/*.pyc"));
});

test("scenario and capability-runner fixtures stay out of the tarball", () => {
  const forbidden = current.filter(path =>
    path.startsWith("scripts/hermes-monitor-scenario")
    || path.startsWith("scripts/hermes-monitor-capability-runner")
    || /\.test\.(ts|js|mjs)$/.test(path),
  );

  assert.deepEqual(forbidden, []);
});

test("no local runtime, session, evidence, or journal artifact is published", () => {
  const forbidden = current.filter(path =>
    path.startsWith(".pi/agent-sessions/")
    || path.startsWith("artifacts/")
    || path.startsWith("plans/")
    || /(^|\/)(audit\.ndjson|events\.jsonl|watch\.lock)$/.test(path)
    || /(^|\/)discovery-[^/]*\.json$/.test(path)
    || /(^|\/)token-/.test(path)
    || path.endsWith(".env"),
  );

  assert.deepEqual(forbidden, []);
});

test("packaged watchdog text carries no secret-like value or raw route identifier", () => {
  const inspectable = current.filter(path =>
    (path.startsWith("hermes/") || path.startsWith("docs/hermes-") || path.includes("set-hermes-watchdog"))
    && /\.(py|md|json|js)$/.test(path),
  );

  assert.ok(inspectable.length > 10, "expected a meaningful set of watchdog files to inspect");
  for (const path of inspectable) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");

    assert.doesNotMatch(text, /\b(?:sk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{16,}/, `${path}: credential-prefixed secret`);
    assert.doesNotMatch(text, /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/, `${path}: Telegram bot token`);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${path}: private key block`);
    assert.doesNotMatch(text, /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}/i, `${path}: literal bearer credential`);
    assert.doesNotMatch(text, /"chatId"\s*:\s*"?-?\d{6,}/, `${path}: raw chat/route identifier`);
    assert.doesNotMatch(text, /\brouteId"?\s*[:=]\s*"[^"<]{8,}"/, `${path}: raw route identifier`);
    assert.doesNotMatch(text, /\bhttps?:\/\/(?!github\.com|raw\.githubusercontent\.com|localhost)\S*\/(?:hook|webhook)\S*/, `${path}: live webhook URL`);
  }
});

test("packaged watchdog runtime hardcodes no token or route literal", () => {
  const modules = current.filter(path => path.startsWith("hermes/skills/hub-watchdog/scripts/") && path.endsWith(".py"));

  assert.equal(modules.length, RUNTIME_PYTHON.length);
  for (const path of modules) {
    const text = readFileSync(join(root, path), "utf8");

    assert.doesNotMatch(text, /\b(?:token|secret|api_key|password)\s*=\s*['"][^'"]{6,}['"]/i, `${path}: hardcoded credential`);
    assert.doesNotMatch(text, /\bsubprocess\b|\bos\.system\b|\bshell=True\b/, `${path}: shell authority`);
  }
});

test("the packaged skill and runbook keep Gate O fail-closed", () => {
  const skill = readFileSync(join(root, "hermes/skills/hub-watchdog/SKILL.md"), "utf8");
  const runbook = readFileSync(join(root, "docs/hermes-watchdog-supervisor.md"), "utf8");

  for (const [label, text] of [["SKILL.md", skill], ["runbook", runbook]]) {
    assert.match(text, /Gate O/, `${label} must name Gate O`);
    assert.doesNotMatch(text, /Gate O (?:is|has) (?:open|passed|proven|satisfied)/i, `${label} must not claim Gate O`);
    assert.doesNotMatch(text, /live origin delivery is (?:enabled|proven|working)/i, `${label} must not claim delivery`);
  }
});

test("npm test verifies Python with the standard library only", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const scripts = Object.values(pkg.scripts).join("\n");

  assert.match(pkg.scripts["test:watchdog-py"], /python3 -m unittest discover/);
  assert.doesNotMatch(scripts, /pytest|pip install/i, "npm scripts must not reach for pytest or pip");
  assert.doesNotMatch(workflow, /pytest/i, "release CI must not install or invoke pytest");
  assert.doesNotMatch(workflow, /pip install|python -m pip|python3 -m pip/i, "release CI must not pip-install a Python dependency");
  assert.doesNotMatch(workflow, /requirements(?:-dev)?\.txt/i, "release CI must not carry a hidden Python dependency file");
  assert.match(workflow, /actions\/setup-python/, "release CI still provisions Python for the stdlib suite");
});

test("no Python dependency manifest is published or committed for the watchdog", () => {
  const manifests = current.filter(path => /(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|Pipfile)$/.test(path));

  assert.deepEqual(manifests, []);
});
